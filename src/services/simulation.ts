import { createHash } from 'node:crypto'

import {
  SIMULATION_DATA_QUALITY,
  SIMULATION_ERROR_CODES,
  SIMULATION_RULES_PROVISIONAL_V1,
  type SimulationBaseScenarioCompleteResult,
  type SimulationBaseScenarioIncompleteResult,
  type SimulationBaseScenarioInput,
  type SimulationBaseScenarioResult,
  type SimulationCalculationParameters,
  type SimulationCalculationResult,
  type SimulationComparisonInput,
  type SimulationComparisonResult,
  type SimulationErrorCode,
  type SimulationRouteSnapshot,
  type SimulationSnapshotHandleVersions,
  type SimulationStockSnapshot,
  type SimulationVariantCalculationResult,
  type SimulationVariantInput
} from '../interfaces/simulation.interface'
import {
  simulationBaseScenarioInputSchema,
  simulationBaseScenarioResultSchema,
  simulationComparisonInputSchema,
  simulationComparisonResultSchema,
  simulationVariantCalculationResultSchema,
  simulationVariantInputSchema
} from '../schemas/simulation.schema'
import {
  buildIncompleteCalculation,
  calculateVariant as calculateVariantResult,
  compareVariants as compareVariantResults
} from './simulationRules'
import {
  SimulationSnapshotError,
  type ValidatedSnapshots
} from './simulationSnapshotAdapter'
import {
  SimulationTokenError,
  type BaseScenarioRequestContext,
  type ValidatedBaseScenario
} from './simulationToken'

export type { SimulationCalculationParameters }

// Dependencies for the provisional service composition. `calculationParameters` is
// test/service input only; it is not approved configuration, so live calculation
// remains unavailable until approved configuration and producers exist.
export interface SimulationBaseScenarioHashInput {
  routeSnapshot: SimulationRouteSnapshot
  stockSnapshot: SimulationStockSnapshot
  versions: SimulationSnapshotHandleVersions
}

export interface SimulationServiceDependencies {
  loadSnapshots: (input: SimulationBaseScenarioInput) => Promise<ValidatedSnapshots>
  issueBaseScenarioToken: (base: ValidatedBaseScenario, context: BaseScenarioRequestContext) => Promise<string>
  verifyBaseScenarioToken: (token: string, context: BaseScenarioRequestContext) => Promise<ValidatedBaseScenario>
  calculationParameters?: SimulationCalculationParameters
  clock?: () => Date
}

export class SimulationServiceError extends Error {
  readonly code: SimulationErrorCode
  readonly field?: string

  constructor (code: SimulationErrorCode, message: string, field?: string) {
    super(message)
    this.name = 'SimulationServiceError'
    this.code = code
    this.field = field
  }
}

const PARAMETER_NAMES = [
  'fuelPriceArsPerLiter',
  'durationCostArsPerHour',
  'distanceCostArsPerKm'
] as const

const MAX_DIAGNOSTIC_LENGTH = 500

const inputInvalid = (message: string, field?: string): SimulationServiceError =>
  new SimulationServiceError(SIMULATION_ERROR_CODES.INPUT_INVALID, message, field)

const configurationUnavailable = (message: string): SimulationServiceError =>
  new SimulationServiceError(SIMULATION_ERROR_CODES.CONFIGURATION_UNAVAILABLE, message)

const isPlainObject = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const canonicalizeValue = (value: unknown, ancestors: Set<object>): string => {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonical JSON rejects non-finite numbers')
      return JSON.stringify(value)
    case 'object':
      break
    default:
      throw new TypeError(`canonical JSON rejects values of type ${typeof value}`)
  }

  const objectValue = value
  if (ancestors.has(objectValue)) throw new TypeError('canonical JSON rejects cycles')

  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) {
      throw new TypeError('canonical JSON rejects sparse or extended arrays')
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError('canonical JSON rejects symbol-keyed arrays')
    }
    ancestors.add(objectValue)
    const items: string[] = []
    for (let index = 0; index < value.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new TypeError('canonical JSON rejects sparse arrays')
      }
      items.push(canonicalizeValue(value[index], ancestors))
    }
    ancestors.delete(objectValue)
    return `[${items.join(',')}]`
  }

  if (!isPlainObject(objectValue)) {
    throw new TypeError('canonical JSON rejects non-plain objects')
  }
  if (Object.getOwnPropertySymbols(objectValue).length > 0) {
    throw new TypeError('canonical JSON rejects symbol-keyed objects')
  }

  const keys = Object.keys(objectValue)
  if (Object.getOwnPropertyNames(objectValue).length !== keys.length) {
    throw new TypeError('canonical JSON rejects non-enumerable object properties')
  }

  ancestors.add(objectValue)
  const record = objectValue as Record<string, unknown>
  const entries = keys
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeValue(record[key], ancestors)}`)
  ancestors.delete(objectValue)
  return `{${entries.join(',')}}`
}

// One canonicalizer for the frozen snapshots, both producer contract versions and
// the rules version. It recursively sorts plain-object keys, preserves array order,
// never mutates its input and rejects values JSON would silently lose.
export const canonicalizeSimulationValue = (value: unknown): string =>
  canonicalizeValue(value, new Set())

export const calculateBaseScenarioHash = (input: SimulationBaseScenarioHashInput): string => {
  const canonicalJson = canonicalizeSimulationValue({
    routeSnapshot: input.routeSnapshot,
    stockSnapshot: input.stockSnapshot,
    versions: {
      routeContractVersion: input.versions.routeContractVersion,
      stockContractVersion: input.versions.stockContractVersion,
      rulesVersion: input.versions.rulesVersion
    }
  })
  return createHash('sha256').update(canonicalJson, 'utf8').digest('hex')
}

const clockNow = (dependencies: SimulationServiceDependencies): string => {
  const clock = dependencies.clock ?? (() => new Date())
  const now = clock()
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw configurationUnavailable('A valid simulation service clock is required')
  }
  return now.toISOString()
}

const rethrowKnownError = (error: unknown): never => {
  if (error instanceof SimulationTokenError) {
    throw new SimulationServiceError(error.code, error.message, error.field)
  }
  throw error
}

const assertBaseScenarioResult = (result: SimulationBaseScenarioResult): SimulationBaseScenarioResult => {
  if (!simulationBaseScenarioResultSchema.safeParse(result).success) {
    throw configurationUnavailable('The base scenario result does not match the declared contract')
  }
  return result
}

const assertCalculationResult = (
  result: SimulationVariantCalculationResult
): SimulationVariantCalculationResult => {
  if (!simulationVariantCalculationResultSchema.safeParse(result).success) {
    throw configurationUnavailable('The calculation result does not match the declared contract')
  }
  return result
}

const assertComparisonResult = (
  result: SimulationComparisonResult
): SimulationComparisonResult => {
  if (!simulationComparisonResultSchema.safeParse(result).success) {
    throw configurationUnavailable('The comparison result does not match the declared contract')
  }
  return result
}

const baseScenarioVersions = (snapshots: ValidatedSnapshots): SimulationSnapshotHandleVersions => ({
  routeContractVersion: snapshots.routeSnapshot.contractVersion,
  stockContractVersion: snapshots.stockSnapshot.contractVersion,
  rulesVersion: SIMULATION_RULES_PROVISIONAL_V1
})

export const createBaseScenario = async (
  input: SimulationBaseScenarioInput,
  context: BaseScenarioRequestContext,
  dependencies: SimulationServiceDependencies
): Promise<SimulationBaseScenarioResult> => {
  const parsedInput = simulationBaseScenarioInputSchema.safeParse(input)
  if (!parsedInput.success) {
    throw inputInvalid('Base scenario input is invalid', 'routeId')
  }

  let snapshots: ValidatedSnapshots
  try {
    snapshots = await dependencies.loadSnapshots(parsedInput.data)
  } catch (error) {
    if (error instanceof SimulationSnapshotError) {
      const incomplete: SimulationBaseScenarioIncompleteResult = {
        dataQuality: SIMULATION_DATA_QUALITY.INCOMPLETE,
        error: {
          code: error.code,
          message: error.message.slice(0, MAX_DIAGNOSTIC_LENGTH)
        }
      }
      if (error.missingField !== undefined) incomplete.missingField = error.missingField
      return assertBaseScenarioResult(incomplete)
    }
    throw error
  }

  const versions = baseScenarioVersions(snapshots)
  const base: ValidatedBaseScenario = {
    ...snapshots,
    versions,
    baseScenarioHash: calculateBaseScenarioHash({ ...snapshots, versions })
  }

  let token: string
  try {
    token = await dependencies.issueBaseScenarioToken(base, context)
  } catch (error) {
    return rethrowKnownError(error)
  }

  const result: SimulationBaseScenarioCompleteResult = {
    dataQuality: SIMULATION_DATA_QUALITY.COMPLETE,
    token,
    baseScenarioHash: base.baseScenarioHash,
    versions
  }
  return assertBaseScenarioResult(result)
}

type ResolvedParameters =
  | { missing: string[] }
  | { values: SimulationCalculationParameters }

const resolveParameters = (
  parameters: SimulationCalculationParameters | undefined
): ResolvedParameters => {
  if (parameters === undefined) return { missing: [...PARAMETER_NAMES] }

  const missing: string[] = []
  for (const name of PARAMETER_NAMES) {
    const value = parameters[name]
    if (value === undefined) {
      missing.push(name)
      continue
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw configurationUnavailable(`Calculation parameter ${name} must be a finite non-negative number`)
    }
  }
  if (missing.length > 0) return { missing }
  return { values: parameters }
}

export const calculateVariant = async (
  token: string,
  input: SimulationVariantInput,
  context: BaseScenarioRequestContext,
  dependencies: SimulationServiceDependencies
): Promise<SimulationVariantCalculationResult> => {
  const parsedInput = simulationVariantInputSchema.safeParse(input)
  if (!parsedInput.success) {
    throw inputInvalid('Variant input is invalid', 'variant')
  }
  if (parsedInput.data.presetVersionId !== undefined) {
    throw inputInvalid('Preset versions are not supported by the provisional calculation contract', 'presetVersionId')
  }
  if (parsedInput.data.overrides.length > 0) {
    throw inputInvalid('Overrides are not supported by the provisional calculation contract', 'overrides')
  }

  let base: ValidatedBaseScenario
  try {
    base = await dependencies.verifyBaseScenarioToken(token, context)
  } catch (error) {
    return rethrowKnownError(error)
  }

  const calculatedAt = clockNow(dependencies)
  const variantId = parsedInput.data.name
  const resolved = resolveParameters(dependencies.calculationParameters)
  if ('missing' in resolved) {
    return assertCalculationResult(buildIncompleteCalculation(
      base.baseScenarioHash,
      variantId,
      resolved.missing,
      calculatedAt
    ))
  }

  let result: SimulationCalculationResult
  try {
    result = calculateVariantResult(
      {
        baseScenarioHash: base.baseScenarioHash,
        routeSnapshot: base.routeSnapshot,
        stockSnapshot: base.stockSnapshot
      },
      parsedInput.data,
      resolved.values,
      calculatedAt
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Direct load could not be calculated'
    throw inputInvalid(message, 'directLoad')
  }

  return assertCalculationResult(result)
}

// Advisory comparison only. The canonical request carries already calculated
// variants, not their inputs, so this operation cannot re-derive the submitted
// totals or formulas. It validates the actor-bound base scenario, ranks the
// supplied server-calculated results and persists nothing; saving a run is the
// separate operation that recalculates from frozen snapshots.
export const compareVariants = async (
  input: SimulationComparisonInput,
  context: BaseScenarioRequestContext,
  dependencies: SimulationServiceDependencies
): Promise<SimulationComparisonResult> => {
  const parsedInput = simulationComparisonInputSchema.safeParse(input)
  if (!parsedInput.success) {
    throw inputInvalid('Comparison input is invalid', 'variants')
  }

  let base: ValidatedBaseScenario
  try {
    base = await dependencies.verifyBaseScenarioToken(parsedInput.data.token, context)
  } catch (error) {
    return rethrowKnownError(error)
  }

  if (parsedInput.data.variants.some((variant) => variant.baseScenarioHash !== base.baseScenarioHash)) {
    throw new SimulationServiceError(
      SIMULATION_ERROR_CODES.BASE_SCENARIO_INVALID,
      'Compared variants belong to a different base scenario'
    )
  }

  // The schema already constrains risk codes to the declared enum; the cast only
  // narrows Zod's widened string[] inference at this validated boundary.
  const variants = parsedInput.data.variants as SimulationCalculationResult[]
  return assertComparisonResult(compareVariantResults(variants))
}
