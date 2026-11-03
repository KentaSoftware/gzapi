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
  simulationVariantCalculationResultSchema,
  simulationVariantInputSchema
} from '../schemas/simulation.schema'
import {
  buildIncompleteCalculation,
  calculateVariant as calculateVariantResult
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

export interface SimulationDemoRoute {
  id: string
  zone: string
  orderCount: number
  driver: string
  vehicle: string
  fuelLiters: number
  distanceKm: number
  durationHours: number
  date: string
}

export interface SimulationDemoProduct {
  id: string
  name: string
  stock: number
  unitPrice: number
}

export interface SimulationDemoScenario {
  id: string
  date: string
  routeId: string
  zone: string
  driver: string
  vehicle: string
  estimatedRevenue: number
  operatingCost: number
  grossMargin: number
}

export interface SimulationDemoRunInput {
  routeId: string
  parameters: {
    fuelPricePerLiter: number
    includeSurplus: boolean
    generalCosts: number
    hourlyRate: number
  }
  products: Array<SimulationDemoProduct & { quantity: number }>
}

const DEMO_ROUTES: readonly SimulationDemoRoute[] = [
  { id: 'R-001', zone: 'Norte', orderCount: 12, driver: 'Juan Pérez', vehicle: 'Móvil 1', fuelLiters: 18.5, distanceKm: 102.4, durationHours: 6.5, date: '26/05/2025' },
  { id: 'R-002', zone: 'Centro', orderCount: 10, driver: 'María López', vehicle: 'Móvil 2', fuelLiters: 15.2, distanceKm: 85.6, durationHours: 5.1, date: '26/05/2025' },
  { id: 'R-003', zone: 'Sur', orderCount: 8, driver: 'Carlos Ruiz', vehicle: 'Móvil 3', fuelLiters: 12.8, distanceKm: 78.3, durationHours: 4.8, date: '26/05/2025' },
  { id: 'R-004', zone: 'Este', orderCount: 15, driver: 'Ana Torres', vehicle: 'Móvil 1', fuelLiters: 22.1, distanceKm: 145.8, durationHours: 8.2, date: '26/05/2025' },
  { id: 'R-005', zone: 'Oeste', orderCount: 9, driver: 'Luis Gómez', vehicle: 'Móvil 2', fuelLiters: 16.4, distanceKm: 98.2, durationHours: 6, date: '26/05/2025' },
  { id: 'R-006', zone: 'Norte', orderCount: 11, driver: 'Juan Pérez', vehicle: 'Móvil 2', fuelLiters: 17.3, distanceKm: 96.1, durationHours: 5.8, date: '25/05/2025' },
  { id: 'R-007', zone: 'Centro', orderCount: 7, driver: 'María López', vehicle: 'Móvil 1', fuelLiters: 11.9, distanceKm: 71.4, durationHours: 4.2, date: '25/05/2025' },
  { id: 'R-008', zone: 'Sur', orderCount: 6, driver: 'Carlos Ruiz', vehicle: 'Móvil 3', fuelLiters: 10.6, distanceKm: 64.8, durationHours: 3.9, date: '25/05/2025' }
]

const DEMO_PRODUCTS: readonly SimulationDemoProduct[] = [
  { id: 'agua-500', name: 'Agua 500 ml', stock: 120, unitPrice: 1200 },
  { id: 'gaseosa-15', name: 'Gaseosa 1.5 L', stock: 90, unitPrice: 2500 },
  { id: 'jugo-1', name: 'Jugo 1 L', stock: 75, unitPrice: 1800 },
  { id: 'snacks', name: 'Snacks', stock: 60, unitPrice: 1000 },
  { id: 'panificados', name: 'Panificados', stock: 40, unitPrice: 1500 }
]

const DEMO_INCLUDED_QUANTITIES: Readonly<Record<string, number>> = {
  'agua-500': 40,
  'gaseosa-15': 30,
  'jugo-1': 20,
  snacks: 25,
  panificados: 15
}

const demoScenarios: SimulationDemoScenario[] = [
  { id: 'ESC-014', date: '26/05/2025', routeId: 'R-001', zone: 'Norte', driver: 'Juan Pérez', vehicle: 'Móvil 1', estimatedRevenue: 485000, operatingCost: 125000, grossMargin: 360000 },
  { id: 'ESC-013', date: '25/05/2025', routeId: 'R-004', zone: 'Este', driver: 'Ana Torres', vehicle: 'Móvil 1', estimatedRevenue: 620000, operatingCost: 168000, grossMargin: 452000 },
  { id: 'ESC-012', date: '24/05/2025', routeId: 'R-002', zone: 'Centro', driver: 'María López', vehicle: 'Móvil 2', estimatedRevenue: 398000, operatingCost: 112000, grossMargin: 286000 },
  { id: 'ESC-011', date: '23/05/2025', routeId: 'R-003', zone: 'Sur', driver: 'Carlos Ruiz', vehicle: 'Móvil 3', estimatedRevenue: 355000, operatingCost: 110000, grossMargin: 245000 },
  { id: 'ESC-010', date: '22/05/2025', routeId: 'R-005', zone: 'Oeste', driver: 'Luis Gómez', vehicle: 'Móvil 2', estimatedRevenue: 410000, operatingCost: 110000, grossMargin: 282000 },
  { id: 'ESC-009', date: '21/05/2025', routeId: 'R-001', zone: 'Norte', driver: 'Juan Pérez', vehicle: 'Móvil 1', estimatedRevenue: 472000, operatingCost: 130000, grossMargin: 342000 },
  { id: 'ESC-008', date: '20/05/2025', routeId: 'R-002', zone: 'Centro', driver: 'María López', vehicle: 'Móvil 2', estimatedRevenue: 365000, operatingCost: 118000, grossMargin: 247000 },
  { id: 'ESC-007', date: '19/05/2025', routeId: 'R-004', zone: 'Este', driver: 'Ana Torres', vehicle: 'Móvil 1', estimatedRevenue: 515000, operatingCost: 150000, grossMargin: 365000 },
  { id: 'ESC-006', date: '18/05/2025', routeId: 'R-003', zone: 'Sur', driver: 'Carlos Ruiz', vehicle: 'Móvil 3', estimatedRevenue: 340000, operatingCost: 104000, grossMargin: 236000 },
  { id: 'ESC-005', date: '17/05/2025', routeId: 'R-005', zone: 'Oeste', driver: 'Luis Gómez', vehicle: 'Móvil 2', estimatedRevenue: 428000, operatingCost: 122000, grossMargin: 306000 },
  { id: 'ESC-004', date: '16/05/2025', routeId: 'R-001', zone: 'Norte', driver: 'Juan Pérez', vehicle: 'Móvil 1', estimatedRevenue: 458000, operatingCost: 119000, grossMargin: 339000 },
  { id: 'ESC-003', date: '15/05/2025', routeId: 'R-002', zone: 'Centro', driver: 'María López', vehicle: 'Móvil 2', estimatedRevenue: 372000, operatingCost: 108000, grossMargin: 264000 },
  { id: 'ESC-002', date: '14/05/2025', routeId: 'R-004', zone: 'Este', driver: 'Ana Torres', vehicle: 'Móvil 1', estimatedRevenue: 496000, operatingCost: 143000, grossMargin: 353000 },
  { id: 'ESC-001', date: '13/05/2025', routeId: 'R-003', zone: 'Sur', driver: 'Carlos Ruiz', vehicle: 'Móvil 3', estimatedRevenue: 322000, operatingCost: 98000, grossMargin: 224000 }
]

const demoPage = <T>(items: readonly T[], page: number, pageSize: number): { items: T[], page: number, pageSize: number, total: number } => {
  const start = (page - 1) * pageSize
  return { items: items.slice(start, start + pageSize), page, pageSize, total: items.length }
}

const getSimulationDemoRoutes = (page: number): ReturnType<typeof demoPage<SimulationDemoRoute>> => demoPage(DEMO_ROUTES, page, 5)

const getSimulationDemoCatalog = (): { available: SimulationDemoProduct[], included: Array<SimulationDemoProduct & { quantity: number }> } => ({
  available: DEMO_PRODUCTS.map((product) => ({ ...product })),
  included: DEMO_PRODUCTS.map((product) => ({ ...product, quantity: DEMO_INCLUDED_QUANTITIES[product.id] ?? 0 }))
})

const getSimulationDemoScenarios = (page: number): ReturnType<typeof demoPage<SimulationDemoScenario>> => demoPage(demoScenarios, page, 8)

const simulateDemoScenario = (input: SimulationDemoRunInput, now = new Date()): SimulationDemoScenario => {
  const route = DEMO_ROUTES.find((entry) => entry.id === input.routeId)
  if (route === undefined) throw new SimulationServiceError(SIMULATION_ERROR_CODES.INPUT_INVALID, 'Unknown route', 'routeId')
  const estimatedRevenue = input.products.reduce((total, product) => total + product.unitPrice * product.quantity, 0)
  const operatingCost = Math.round(route.fuelLiters * input.parameters.fuelPricePerLiter + route.durationHours * input.parameters.hourlyRate + input.parameters.generalCosts)
  const nextId = demoScenarios.reduce((highest, entry) => {
    const parsed = Number.parseInt(entry.id.slice(4), 10)
    return Math.max(highest, Number.isFinite(parsed) ? parsed : 0)
  }, 0) + 1
  const result: SimulationDemoScenario = {
    id: `ESC-${String(nextId).padStart(3, '0')}`,
    date: new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Argentina/Buenos_Aires' }).format(now),
    routeId: route.id,
    zone: route.zone,
    driver: route.driver,
    vehicle: route.vehicle,
    estimatedRevenue: Math.round(estimatedRevenue),
    operatingCost,
    grossMargin: Math.round(estimatedRevenue - operatingCost)
  }
  demoScenarios.unshift(result)
  return { ...result }
}

export { getSimulationDemoCatalog, getSimulationDemoRoutes, getSimulationDemoScenarios, simulateDemoScenario }

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
