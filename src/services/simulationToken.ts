import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { z } from 'zod'

import {
  SIMULATION_ERROR_CODES,
  SIMULATION_ROUTE_SNAPSHOT_STATUSES,
  type SimulationRouteSnapshot,
  type SimulationSnapshotHandle,
  type SimulationSnapshotHandleRepository,
  type SimulationSnapshotHandleVersions,
  type SimulationStockSnapshot
} from '../interfaces/simulation.interface'
import {
  simulationRouteSnapshotSchema,
  simulationStockSnapshotSchema
} from '../schemas/simulation.schema'

// Provisional technical choices for SIMULATION_MVP_PROVISIONAL_V1, not product
// rules. The wire token is `sim2.` + a 256-bit random handle + an HMAC-SHA256
// authenticator. It carries no snapshot data: the frozen evidence lives in the
// expiring server-side handle store and is looked up by a deterministic digest.
// Token encoding and lifetime may change without changing the public issue/verify
// contract.
const BASE_SCENARIO_TOKEN_PREFIX = 'sim2'
const BASE_SCENARIO_TOKEN_LIFETIME_SECONDS = 15 * 60
// Must stay aligned with tokenSchema in src/schemas/simulation.schema.ts (max 4096).
const BASE_SCENARIO_TOKEN_MAX_LENGTH = 4096
const BASE_SCENARIO_TOKEN_SECRET_MIN_BYTES = 32
const BASE_SCENARIO_HANDLE_BYTES = 32
const BASE_SCENARIO_MAC_BYTES = 32
const BASE_SCENARIO_HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/
const BASE_SCENARIO_TOKEN_PATTERN = /^sim2\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/

interface ValidatedBaseScenario {
  routeSnapshot: SimulationRouteSnapshot
  stockSnapshot: SimulationStockSnapshot
  versions: SimulationSnapshotHandleVersions
  baseScenarioHash: string
}

type BaseScenarioVersions = SimulationSnapshotHandleVersions

interface BaseScenarioRequestContext {
  actorId: string
}

interface BaseScenarioTokenDependencies {
  secret: string | Buffer
  clock: () => Date
  lifetimeSeconds?: number
  repository: SimulationSnapshotHandleRepository
  routeContractAllowlist: readonly string[]
  stockContractAllowlist: readonly string[]
}

const TOKEN_ERROR_CODES = {
  INVALID: SIMULATION_ERROR_CODES.TOKEN_INVALID,
  EXPIRED: SIMULATION_ERROR_CODES.TOKEN_EXPIRED,
  CONFIGURATION_UNAVAILABLE: SIMULATION_ERROR_CODES.CONFIGURATION_UNAVAILABLE,
  REPOSITORY: SIMULATION_ERROR_CODES.REPOSITORY_ERROR
} as const

type BaseScenarioTokenErrorCode = (typeof TOKEN_ERROR_CODES)[keyof typeof TOKEN_ERROR_CODES]

class SimulationTokenError extends Error {
  readonly code: BaseScenarioTokenErrorCode
  readonly field?: string

  constructor (code: BaseScenarioTokenErrorCode, message: string, field?: string) {
    super(message)
    this.name = 'SimulationTokenError'
    this.code = code
    this.field = field
  }
}

const actorIdSchema = z.string().trim().min(1).max(128)
const versionIdentifierSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
const baseScenarioHashSchema = z.string().trim().regex(/^[a-f0-9]{64}$/)
const handleDigestSchema = z.string().trim().regex(/^[a-f0-9]{64}$/)
const contractAllowlistSchema = z.array(versionIdentifierSchema)

interface VersionBinding {
  routeSnapshot: { contractVersion: string, status?: string }
  stockSnapshot: { contractVersion: string }
  versions: {
    routeContractVersion: string
    stockContractVersion: string
  }
}

const versionsMatchSnapshots = (value: VersionBinding): boolean =>
  value.routeSnapshot.contractVersion === value.versions.routeContractVersion &&
  value.stockSnapshot.contractVersion === value.versions.stockContractVersion

const bindingIssue = (value: VersionBinding): string | undefined => {
  if (!versionsMatchSnapshots(value)) return 'declared versions must match the frozen snapshots'
  if (value.routeSnapshot.status !== SIMULATION_ROUTE_SNAPSHOT_STATUSES.VALIDATED) {
    return 'route snapshot must describe a validated route'
  }
  return undefined
}

const baseScenarioApiVersionsSchema = z.object({
  routeContractVersion: versionIdentifierSchema,
  stockContractVersion: versionIdentifierSchema,
  rulesVersion: versionIdentifierSchema
}).strict()

const baseScenarioFields = {
  routeSnapshot: simulationRouteSnapshotSchema,
  stockSnapshot: simulationStockSnapshotSchema,
  versions: baseScenarioApiVersionsSchema,
  baseScenarioHash: baseScenarioHashSchema
}

const baseScenarioSchema = z.object(baseScenarioFields).strict().superRefine((value, ctx) => {
  const issue = bindingIssue(value)
  if (issue !== undefined) ctx.addIssue({ code: 'custom', message: issue, path: ['versions'] })
})

const snapshotHandleRecordSchema = z.object({
  handleDigest: handleDigestSchema,
  actorId: actorIdSchema,
  ...baseScenarioFields,
  issuedAt: z.date(),
  expiresAt: z.date()
}).strict().superRefine((value, ctx) => {
  const issue = bindingIssue(value)
  if (issue !== undefined) ctx.addIssue({ code: 'custom', message: issue, path: ['versions'] })
  if (value.expiresAt.getTime() <= value.issuedAt.getTime()) {
    ctx.addIssue({ code: 'custom', message: 'handle expiration must follow issuance', path: ['expiresAt'] })
  }
})

const invalidToken = (message: string): SimulationTokenError =>
  new SimulationTokenError(TOKEN_ERROR_CODES.INVALID, message)

const configurationUnavailable = (message: string): SimulationTokenError =>
  new SimulationTokenError(TOKEN_ERROR_CODES.CONFIGURATION_UNAVAILABLE, message)

const repositoryUnavailable = (): SimulationTokenError =>
  new SimulationTokenError(TOKEN_ERROR_CODES.REPOSITORY, 'The base scenario handle store is unavailable')

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    const record = value as unknown as Record<string, unknown>
    for (const key of Object.keys(record)) deepFreeze(record[key])
    Object.freeze(value)
  }
  return value
}

const secretBuffer = (dependencies: BaseScenarioTokenDependencies): Buffer => {
  const secret = typeof dependencies.secret === 'string' ? Buffer.from(dependencies.secret, 'utf8') : dependencies.secret
  if (secret.length < BASE_SCENARIO_TOKEN_SECRET_MIN_BYTES || secret.toString('utf8').trim() === '') {
    throw configurationUnavailable(`A base scenario token secret of at least ${BASE_SCENARIO_TOKEN_SECRET_MIN_BYTES} bytes is required`)
  }
  return secret
}

const clockMillis = (dependencies: BaseScenarioTokenDependencies): number => {
  const millis = dependencies.clock().getTime()
  if (!Number.isFinite(millis)) throw configurationUnavailable('A valid base scenario token clock is required')
  return millis
}

const lifetimeSeconds = (dependencies: BaseScenarioTokenDependencies): number => {
  const seconds = dependencies.lifetimeSeconds ?? BASE_SCENARIO_TOKEN_LIFETIME_SECONDS
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw configurationUnavailable('A positive base scenario token lifetime is required')
  }
  return seconds
}

const repositoryOf = (dependencies: BaseScenarioTokenDependencies): SimulationSnapshotHandleRepository => {
  const repository = dependencies.repository
  if (repository === undefined ||
    typeof repository.insert !== 'function' ||
    typeof repository.findByHandleDigest !== 'function') {
    throw configurationUnavailable('A base scenario handle store is required')
  }
  return repository
}

const allowlistOf = (values: readonly string[], label: string): Set<string> => {
  const parsed = contractAllowlistSchema.safeParse(values)
  if (!parsed.success) throw configurationUnavailable(`The ${label} contract allowlist is invalid`)
  return new Set(parsed.data)
}

const assertApprovedBaseScenario = (
  value: ValidatedBaseScenario,
  dependencies: BaseScenarioTokenDependencies
): void => {
  if (value.routeSnapshot.status !== SIMULATION_ROUTE_SNAPSHOT_STATUSES.VALIDATED) {
    throw invalidToken('Base scenario route snapshot must be validated')
  }
  const routeAllowlist = allowlistOf(dependencies.routeContractAllowlist, 'route')
  const stockAllowlist = allowlistOf(dependencies.stockContractAllowlist, 'stock')
  if (!routeAllowlist.has(value.routeSnapshot.contractVersion) ||
    !routeAllowlist.has(value.versions.routeContractVersion)) {
    throw invalidToken('Base scenario route contract version is not allowlisted')
  }
  if (!stockAllowlist.has(value.stockSnapshot.contractVersion) ||
    !stockAllowlist.has(value.versions.stockContractVersion)) {
    throw invalidToken('Base scenario stock contract version is not allowlisted')
  }
}

const tokenMac = (handle: string, secret: Buffer): Buffer =>
  createHmac('sha256', secret)
    .update(`${BASE_SCENARIO_TOKEN_PREFIX}.${handle}`, 'utf8')
    .digest()

const handleDigestOf = (handle: string): string =>
  createHash('sha256')
    .update(Buffer.from(handle, 'base64url'))
    .digest('hex')

const issueBaseScenarioToken = async (
  base: ValidatedBaseScenario,
  context: BaseScenarioRequestContext,
  dependencies: BaseScenarioTokenDependencies
): Promise<string> => {
  const parsedBase = baseScenarioSchema.safeParse(base)
  if (!parsedBase.success) {
    throw invalidToken('Base scenario is not a valid frozen snapshot set')
  }
  const validatedBase = parsedBase.data as ValidatedBaseScenario
  assertApprovedBaseScenario(validatedBase, dependencies)

  const actorId = actorIdSchema.safeParse(context.actorId)
  if (!actorId.success) throw invalidToken('A base scenario token actor is required')

  const secret = secretBuffer(dependencies)
  const repository = repositoryOf(dependencies)
  const issuedAtMillis = clockMillis(dependencies)
  const expiresAtMillis = issuedAtMillis + lifetimeSeconds(dependencies) * 1000
  const handle = randomBytes(BASE_SCENARIO_HANDLE_BYTES).toString('base64url')
  const token = `${BASE_SCENARIO_TOKEN_PREFIX}.${handle}.${tokenMac(handle, secret).toString('base64url')}`

  if (token.length > BASE_SCENARIO_TOKEN_MAX_LENGTH) {
    throw invalidToken('Base scenario handle token exceeds the size limit')
  }

  const handleRecord: SimulationSnapshotHandle = {
    handleDigest: handleDigestOf(handle),
    actorId: actorId.data,
    routeSnapshot: validatedBase.routeSnapshot,
    stockSnapshot: validatedBase.stockSnapshot,
    versions: validatedBase.versions,
    baseScenarioHash: validatedBase.baseScenarioHash,
    issuedAt: new Date(issuedAtMillis),
    expiresAt: new Date(expiresAtMillis)
  }

  try {
    await repository.insert(handleRecord)
  } catch {
    throw repositoryUnavailable()
  }

  return token
}

const verifyBaseScenarioToken = async (
  token: string,
  context: BaseScenarioRequestContext,
  dependencies: BaseScenarioTokenDependencies
): Promise<ValidatedBaseScenario> => {
  if (typeof token !== 'string' || token.length === 0 || token.length > BASE_SCENARIO_TOKEN_MAX_LENGTH) {
    throw invalidToken('Base scenario handle token is malformed or exceeds the size limit')
  }

  const match = BASE_SCENARIO_TOKEN_PATTERN.exec(token)
  if (match === null) throw invalidToken('Base scenario handle token is malformed')

  const handle = match[1]
  const providedMac = match[2]
  if (!BASE_SCENARIO_HANDLE_PATTERN.test(handle)) throw invalidToken('Base scenario handle token is malformed')

  const secret = secretBuffer(dependencies)
  const providedMacBytes = Buffer.from(providedMac, 'base64url')
  if (providedMacBytes.length !== BASE_SCENARIO_MAC_BYTES ||
    providedMacBytes.toString('base64url') !== providedMac) {
    throw invalidToken('Base scenario handle authenticator is invalid')
  }
  const expectedMacBytes = tokenMac(handle, secret)
  if (!timingSafeEqual(providedMacBytes, expectedMacBytes)) {
    throw invalidToken('Base scenario handle authenticator is invalid')
  }

  const repository = repositoryOf(dependencies)
  const digest = handleDigestOf(handle)
  let stored: unknown
  try {
    stored = await repository.findByHandleDigest(digest)
  } catch {
    throw repositoryUnavailable()
  }
  if (stored === null || stored === undefined) throw invalidToken('Base scenario handle is not available')

  const record = snapshotHandleRecordSchema.safeParse(stored)
  if (!record.success) throw invalidToken('Base scenario handle record is invalid')
  if (record.data.handleDigest !== digest) throw invalidToken('Base scenario handle record is invalid')

  const validatedBase: ValidatedBaseScenario = {
    routeSnapshot: record.data.routeSnapshot as SimulationRouteSnapshot,
    stockSnapshot: record.data.stockSnapshot as SimulationStockSnapshot,
    versions: record.data.versions,
    baseScenarioHash: record.data.baseScenarioHash
  }
  assertApprovedBaseScenario(validatedBase, dependencies)

  const actorId = actorIdSchema.safeParse(context.actorId)
  if (!actorId.success || actorId.data !== record.data.actorId) {
    throw invalidToken('Base scenario handle is bound to a different actor')
  }

  const nowMillis = clockMillis(dependencies)
  if (nowMillis >= record.data.expiresAt.getTime()) {
    throw new SimulationTokenError(TOKEN_ERROR_CODES.EXPIRED, 'Base scenario handle has expired')
  }

  // The canonical hash is produced by the SIM-22b canonicalizer. This handle only
  // binds the supplied digest so token, compare and persist share one value without
  // duplicating or recomputing the canonicalizer in this slice.
  return deepFreeze(validatedBase)
}

export {
  BASE_SCENARIO_TOKEN_LIFETIME_SECONDS,
  BASE_SCENARIO_TOKEN_MAX_LENGTH,
  BASE_SCENARIO_TOKEN_PREFIX,
  SimulationTokenError,
  TOKEN_ERROR_CODES,
  issueBaseScenarioToken,
  verifyBaseScenarioToken
}
export type {
  BaseScenarioRequestContext,
  BaseScenarioTokenDependencies,
  BaseScenarioTokenErrorCode,
  BaseScenarioVersions,
  ValidatedBaseScenario
}
