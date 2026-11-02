import { createHash } from 'node:crypto'

import {
  SIMULATION_DATA_QUALITY,
  SIMULATION_ERROR_CODES,
  SIMULATION_RISK_CODES,
  SIMULATION_RULES_PROVISIONAL_V1,
  SIMULATION_VIABILITY,
  type SimulationBaseScenarioCompleteResult,
  type SimulationBaseScenarioIncompleteResult,
  type SimulationBaseScenarioInput,
  type SimulationBaseScenarioResult,
  type SimulationCalculationResult,
  type SimulationErrorCode,
  type SimulationIncompleteCalculationResult,
  type SimulationRiskCode,
  type SimulationRouteSnapshot,
  type SimulationSnapshotHandleVersions,
  type SimulationStockSnapshot,
  type SimulationVariantCalculationResult,
  type SimulationVariantInput
} from '../interfaces/simulation.interface'
import {
  simulationBaseScenarioInputSchema,
  simulationBaseScenarioResultSchema,
  simulationVariantCalculationResultSchema,
  simulationVariantInputSchema
} from '../schemas/simulation.schema'
import {
  calculateDirectLoadTotals,
  calculateDistanceBasedCostArs,
  calculateDurationBasedCostArs,
  calculateFuelCostArs,
  roundCommercialAmount
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

// Provisional technical inputs for composing the existing pure helpers. There are
// no defaults: when a caller cannot supply all approved values, the function must
// return the incomplete state instead of treating a missing value as zero.
export interface SimulationCalculationParameters {
  fuelPriceArsPerLiter: number
  durationCostArsPerHour: number
  distanceCostArsPerKm: number
}

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

const variantIdOf = (name: string): string => name.trim().replace(/\s+/g, '_')

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

const incompleteCalculation = (
  base: ValidatedBaseScenario,
  variantId: string,
  missingFields: string[],
  calculatedAt: string
): SimulationIncompleteCalculationResult => ({
  baseScenarioHash: base.baseScenarioHash,
  variantId,
  dataQuality: SIMULATION_DATA_QUALITY.INCOMPLETE,
  viability: SIMULATION_VIABILITY.INCOMPLETE,
  recommended: false,
  risks: [SIMULATION_RISK_CODES.INCOMPLETE_DATA],
  missingFields,
  calculatedAt
})

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
  const variantId = variantIdOf(parsedInput.data.name)
  const resolved = resolveParameters(dependencies.calculationParameters)
  if ('missing' in resolved) {
    return assertCalculationResult(incompleteCalculation(base, variantId, resolved.missing, calculatedAt))
  }

  let directLoad: { revenueArs: number, merchandiseCostArs: number }
  try {
    directLoad = calculateDirectLoadTotals(base.stockSnapshot, parsedInput.data.directLoad)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Direct load could not be calculated'
    throw inputInvalid(message, 'directLoad')
  }

  const fuelArs = calculateFuelCostArs({
    distanceMeters: base.routeSnapshot.distanceMeters,
    consumptionLitersPer100Km: base.routeSnapshot.vehicle.fuelConsumptionLitersPer100Km,
    priceArsPerLiter: resolved.values.fuelPriceArsPerLiter
  })
  const durationArs = calculateDurationBasedCostArs(
    base.routeSnapshot.durationSeconds,
    resolved.values.durationCostArsPerHour
  )
  const distanceArs = calculateDistanceBasedCostArs(
    base.routeSnapshot.distanceMeters,
    resolved.values.distanceCostArsPerKm
  )
  const tollsArs = roundCommercialAmount(base.routeSnapshot.tollsArs)
  const parkingArs = roundCommercialAmount(base.routeSnapshot.parkingArs)
  const operatingCostArs = roundCommercialAmount(
    fuelArs + durationArs + distanceArs + tollsArs + parkingArs
  )
  const marginArs = roundCommercialAmount(
    directLoad.revenueArs - operatingCostArs - directLoad.merchandiseCostArs
  )
  const negativeMargin = marginArs < 0
  const risks: SimulationRiskCode[] = negativeMargin ? [SIMULATION_RISK_CODES.NEGATIVE_MARGIN] : []

  const result: SimulationCalculationResult = {
    baseScenarioHash: base.baseScenarioHash,
    variantId,
    dataQuality: SIMULATION_DATA_QUALITY.COMPLETE,
    viability: negativeMargin ? SIMULATION_VIABILITY.NOT_VIABLE : SIMULATION_VIABILITY.VIABLE,
    recommended: false,
    risks,
    components: [
      { code: 'fuel', amountArs: fuelArs },
      { code: 'duration', amountArs: durationArs },
      { code: 'distance', amountArs: distanceArs },
      { code: 'tolls', amountArs: tollsArs },
      { code: 'parking', amountArs: parkingArs },
      { code: 'merchandise', amountArs: directLoad.merchandiseCostArs }
    ],
    totals: {
      revenueArs: directLoad.revenueArs,
      merchandiseCostArs: directLoad.merchandiseCostArs,
      operatingCostArs,
      marginArs
    },
    calculatedAt
  }

  return assertCalculationResult(result)
}
