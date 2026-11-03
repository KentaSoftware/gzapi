import {
  SIMULATION_CONTRACT_IDS,
  SIMULATION_ERROR_CODES,
  SIMULATION_ROUTE_SNAPSHOT_STATUSES,
  type SimulationBaseScenarioInput,
  type SimulationRouteSnapshot,
  type SimulationStockSnapshot
} from '../interfaces/simulation.interface'
import {
  objectIdSchema,
  simulationRouteSnapshotSchema,
  simulationStockSnapshotSchema
} from '../schemas/simulation.schema'

// Read-only producer boundary for the provisional Simulation MVP. It accepts only
// the declared flattened snapshots or the generic `{ version, data }` envelope,
// never derives a snapshot from a route identifier and never writes to a producer.
interface SimulationRouteSnapshotProducer {
  readRouteSnapshot: (routeId: string) => Promise<unknown>
}

interface SimulationStockSnapshotProducer {
  readStockSnapshot: () => Promise<unknown>
}

interface SimulationSnapshotAdapterDependencies {
  routeProducer: SimulationRouteSnapshotProducer
  stockProducer: SimulationStockSnapshotProducer
  routeContractAllowlist: readonly string[]
  stockContractAllowlist: readonly string[]
}

interface ValidatedSnapshots {
  routeSnapshot: SimulationRouteSnapshot
  stockSnapshot: SimulationStockSnapshot
}

const SNAPSHOT_ERROR_CODES = {
  NOT_APPROVED: SIMULATION_ERROR_CODES.CONTRACT_NOT_APPROVED,
  INCOMPATIBLE: SIMULATION_ERROR_CODES.CONTRACT_INCOMPATIBLE,
  INCOMPLETE: SIMULATION_ERROR_CODES.SNAPSHOT_INCOMPLETE,
  PRODUCER_UNAVAILABLE: SIMULATION_ERROR_CODES.PRODUCER_UNAVAILABLE
} as const

type SimulationSnapshotErrorCode = (typeof SNAPSHOT_ERROR_CODES)[keyof typeof SNAPSHOT_ERROR_CODES]

// These bounds mirror the declared snapshot schemas. They are checked before
// iterating producer-controlled arrays so an oversized payload cannot force a
// full traversal before schema validation runs.
const MAX_ROUTE_STOPS = 1000
const MAX_ROUTE_STOP_SALE_IDS = 1000
const MAX_STOCK_PRODUCTS = 10000
const MAX_CONTRACT_VERSION_LENGTH = 64
const MAX_ERROR_MESSAGE_LENGTH = 500
const MAX_SCHEMA_ISSUES = 20

class SimulationSnapshotError extends Error {
  readonly code: SimulationSnapshotErrorCode
  readonly missingField?: string

  constructor (code: SimulationSnapshotErrorCode, message: string, missingField?: string) {
    super(message)
    this.name = 'SimulationSnapshotError'
    this.code = code
    this.missingField = missingField
  }
}

interface UnwrappedSnapshot {
  payload: Record<string, unknown>
  envelopeVersion?: string
}

interface SchemaIssue {
  path: PropertyKey[]
  message: string
}

interface SchemaError {
  issues: SchemaIssue[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasPath = (input: unknown, path: string): boolean => {
  let current = input
  for (const segment of path.split('.')) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return false
    current = current[segment]
  }
  return current !== undefined && current !== null
}

const readPath = (input: unknown, path: string): unknown => {
  let current = input
  for (const segment of path.split('.')) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    const record = value as unknown as Record<string, unknown>
    for (const key of Object.keys(record)) deepFreeze(record[key])
    Object.freeze(value)
  }
  return value
}

const boundedContractVersion = (version: string): string => {
  const trimmed = version.trim()
  return trimmed.length > MAX_CONTRACT_VERSION_LENGTH
    ? `${trimmed.slice(0, MAX_CONTRACT_VERSION_LENGTH)}...`
    : trimmed
}

const sanitizeDiagnostic = (message: string): string => {
  let sanitized = ''
  for (const character of message) {
    const code = character.codePointAt(0) ?? 0
    sanitized += code < 0x20 || code === 0x7f ? ' ' : character
  }
  return sanitized.replace(/\s+/g, ' ').trim()
}

const boundedMessage = (message: string): string => {
  const sanitized = sanitizeDiagnostic(message)
  return sanitized.length <= MAX_ERROR_MESSAGE_LENGTH
    ? sanitized
    : `${sanitized.slice(0, MAX_ERROR_MESSAGE_LENGTH - 3)}...`
}

const notApproved = (contractId: string, version: string): SimulationSnapshotError =>
  new SimulationSnapshotError(
    SNAPSHOT_ERROR_CODES.NOT_APPROVED,
    boundedMessage(`${contractId} snapshot version ${boundedContractVersion(version)} is not allowlisted`)
  )

const incompatible = (message: string): SimulationSnapshotError =>
  new SimulationSnapshotError(SNAPSHOT_ERROR_CODES.INCOMPATIBLE, boundedMessage(message))

const oversizedSnapshot = (contractId: string, field: string): SimulationSnapshotError =>
  incompatible(`${contractId} snapshot ${field} exceeds the supported bound`)

const incomplete = (contractId: string, field: string): SimulationSnapshotError =>
  new SimulationSnapshotError(
    SNAPSHOT_ERROR_CODES.INCOMPLETE,
    boundedMessage(`${contractId} snapshot is missing required field ${field}`),
    field
  )

const unwrap = (
  raw: unknown,
  allowlist: readonly string[],
  contractId: string
): UnwrappedSnapshot => {
  if (!isRecord(raw)) throw incompatible(`${contractId} snapshot must be an object`)

  const hasVersion = Object.prototype.hasOwnProperty.call(raw, 'version')
  const hasData = Object.prototype.hasOwnProperty.call(raw, 'data')
  if (!hasVersion && !hasData) return { payload: raw }
  if (!hasVersion || !hasData) {
    throw incompatible(`${contractId} producer envelope must declare both version and data`)
  }
  if (typeof raw.version !== 'string' || raw.version.trim() === '') {
    throw incompatible(`${contractId} producer envelope version must be a non-empty string`)
  }
  if (!allowlist.includes(raw.version)) throw notApproved(contractId, raw.version)
  if (!isRecord(raw.data)) {
    throw incompatible(`${contractId} producer envelope data must be an object`)
  }

  const payload = raw.data
  const payloadVersion = readPath(payload, 'contractVersion')
  if (typeof payloadVersion === 'string' && payloadVersion !== raw.version) {
    throw incompatible(`${contractId} producer envelope version must equal the payload contract version`)
  }

  return { payload, envelopeVersion: raw.version }
}

const assertRouteBounds = (payload: Record<string, unknown>, contractId: string): void => {
  const stops = payload.stops
  if (!Array.isArray(stops)) return
  if (stops.length > MAX_ROUTE_STOPS) throw oversizedSnapshot(contractId, 'stops')
  for (let index = 0; index < stops.length; index++) {
    const stop = stops[index]
    if (!isRecord(stop)) continue
    const saleIds = stop.saleIds
    if (Array.isArray(saleIds) && saleIds.length > MAX_ROUTE_STOP_SALE_IDS) {
      throw oversizedSnapshot(contractId, `stops[${index}].saleIds`)
    }
  }
}

const assertStockBounds = (payload: Record<string, unknown>, contractId: string): void => {
  const products = payload.products
  if (!Array.isArray(products)) return
  if (products.length > MAX_STOCK_PRODUCTS) throw oversizedSnapshot(contractId, 'products')
}

const missingRouteField = (payload: Record<string, unknown>): string | undefined => {
  const topLevelFields = [
    'contractVersion',
    'capturedAt',
    'routeId',
    'status',
    'zoneCode',
    'stops',
    'distanceMeters',
    'durationSeconds',
    'vehicle',
    'capacity',
    'tollsArs',
    'parkingArs'
  ]
  for (const field of topLevelFields) {
    if (!hasPath(payload, field)) return field
  }

  const stops = payload.stops
  if (!Array.isArray(stops) || stops.length === 0) return 'stops'
  for (let index = 0; index < stops.length; index++) {
    for (const field of ['sequence', 'clientId', 'saleIds']) {
      if (!hasPath(stops[index], field)) return `stops[${index}].${field}`
    }
    const saleIds = readPath(stops[index], 'saleIds')
    if (Array.isArray(saleIds) && saleIds.length === 0) return `stops[${index}].saleIds`
  }

  for (const field of ['vehicleCode', 'fuelConsumptionLitersPer100Km']) {
    if (!hasPath(payload, `vehicle.${field}`)) return `vehicle.${field}`
  }

  for (const measure of ['maxWeight', 'maxVolume']) {
    if (!hasPath(payload, `capacity.${measure}`)) return `capacity.${measure}`
    for (const field of ['value', 'unit']) {
      if (!hasPath(payload, `capacity.${measure}.${field}`)) return `capacity.${measure}.${field}`
    }
  }

  return undefined
}

const missingStockField = (payload: Record<string, unknown>): string | undefined => {
  for (const field of ['contractVersion', 'capturedAt', 'products']) {
    if (!hasPath(payload, field)) return field
  }

  const products = payload.products
  if (!Array.isArray(products) || products.length === 0) return 'products'
  for (let index = 0; index < products.length; index++) {
    for (const field of ['productId', 'availableQuantity', 'unitCostArs', 'presalePriceArs', 'weight', 'volume']) {
      if (!hasPath(products[index], field)) return `products[${index}].${field}`
    }
    for (const measure of ['weight', 'volume']) {
      for (const field of ['value', 'unit']) {
        if (!hasPath(products[index], `${measure}.${field}`)) return `products[${index}].${measure}.${field}`
      }
    }
  }

  return undefined
}

const validateAllowlist = (
  payload: Record<string, unknown>,
  allowlist: readonly string[],
  contractId: string
): void => {
  const version = readPath(payload, 'contractVersion')
  if (typeof version === 'string' && !allowlist.includes(version)) {
    throw notApproved(contractId, version)
  }
}

const schemaIssues = (error: SchemaError): string => {
  const issues = error.issues
    .slice(0, MAX_SCHEMA_ISSUES)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
    .join('; ')
  const remaining = error.issues.length - MAX_SCHEMA_ISSUES
  return remaining > 0 ? `${issues}; ... ${remaining} more issues` : issues
}

const reconcileRouteSnapshot = (raw: unknown, allowlist: readonly string[]): SimulationRouteSnapshot => {
  const contractId = SIMULATION_CONTRACT_IDS.ROUTE
  const { payload } = unwrap(raw, allowlist, contractId)

  assertRouteBounds(payload, contractId)
  const missingField = missingRouteField(payload)
  if (missingField !== undefined) throw incomplete(contractId, missingField)

  validateAllowlist(payload, allowlist, contractId)

  if (payload.status !== SIMULATION_ROUTE_SNAPSHOT_STATUSES.VALIDATED) {
    throw incompatible(`${contractId} snapshot must describe a validated route`)
  }

  const parsed = simulationRouteSnapshotSchema.safeParse(payload)
  if (!parsed.success) {
    throw incompatible(`${contractId} snapshot does not match the declared schema: ${schemaIssues(parsed.error)}`)
  }

  return deepFreeze(parsed.data as SimulationRouteSnapshot)
}

const reconcileStockSnapshot = (raw: unknown, allowlist: readonly string[]): SimulationStockSnapshot => {
  const contractId = SIMULATION_CONTRACT_IDS.STOCK
  const { payload } = unwrap(raw, allowlist, contractId)

  assertStockBounds(payload, contractId)
  const missingField = missingStockField(payload)
  if (missingField !== undefined) throw incomplete(contractId, missingField)

  validateAllowlist(payload, allowlist, contractId)

  const parsed = simulationStockSnapshotSchema.safeParse(payload)
  if (!parsed.success) {
    throw incompatible(`${contractId} snapshot does not match the declared schema: ${schemaIssues(parsed.error)}`)
  }

  return deepFreeze(parsed.data as SimulationStockSnapshot)
}

const producerUnavailable = (producer: string): SimulationSnapshotError => {
  return new SimulationSnapshotError(
    SNAPSHOT_ERROR_CODES.PRODUCER_UNAVAILABLE,
    `${producer} snapshot producer is unavailable`
  )
}

const normalizeRouteId = (value: unknown): string => {
  const parsed = objectIdSchema.safeParse(value)
  if (!parsed.success) throw incompatible('requested route identifier must be a valid ObjectId')
  return parsed.data.toLowerCase()
}

const loadSnapshots = async (
  input: SimulationBaseScenarioInput,
  dependencies: SimulationSnapshotAdapterDependencies
): Promise<ValidatedSnapshots> => {
  const requestedRouteId = normalizeRouteId(input.routeId)
  let rawRouteSnapshot: unknown
  try {
    rawRouteSnapshot = await dependencies.routeProducer.readRouteSnapshot(requestedRouteId)
  } catch {
    throw producerUnavailable('Route')
  }
  const routeSnapshot = reconcileRouteSnapshot(rawRouteSnapshot, dependencies.routeContractAllowlist)
  if (routeSnapshot.routeId.trim().toLowerCase() !== requestedRouteId) {
    throw incompatible(`${SIMULATION_CONTRACT_IDS.ROUTE} snapshot route identity does not match the requested route`)
  }

  let rawStockSnapshot: unknown
  try {
    rawStockSnapshot = await dependencies.stockProducer.readStockSnapshot()
  } catch {
    throw producerUnavailable('Stock')
  }
  const stockSnapshot = reconcileStockSnapshot(rawStockSnapshot, dependencies.stockContractAllowlist)

  return Object.freeze({ routeSnapshot, stockSnapshot })
}

export {
  SimulationSnapshotError,
  SNAPSHOT_ERROR_CODES,
  loadSnapshots,
  reconcileRouteSnapshot,
  reconcileStockSnapshot
}
export type {
  SimulationRouteSnapshotProducer,
  SimulationStockSnapshotProducer,
  SimulationSnapshotAdapterDependencies,
  SimulationSnapshotErrorCode,
  ValidatedSnapshots
}
