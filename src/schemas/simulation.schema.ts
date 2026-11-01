import { z } from 'zod'

import {
  SIMULATION_DATA_QUALITY,
  SIMULATION_ERROR_CODES,
  SIMULATION_RISK_CODES,
  SIMULATION_ROUTE_SNAPSHOT_STATUSES,
  SIMULATION_VIABILITY,
  type SimulationErrorCode
} from '../interfaces/simulation.interface'

const objectIdSchema = z.string().trim().regex(/^[a-fA-F0-9]{24}$/, 'value must be an ObjectId')
const boundedIdentifierSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'value must be a bounded identifier')
const labelSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/, 'value must be a bounded label')
const contractVersionSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'value must be a contract version')
const unitSchema = z.string().trim().min(1).max(16).regex(/^[A-Za-z][A-Za-z0-9./_-]*$/, 'value must be a bounded unit')
const tokenSchema = z.string().trim().min(8).max(4096).regex(/^[A-Za-z0-9._~-]+$/, 'token must be an opaque bounded value')
const reasonSchema = z.string().trim().min(1).max(500)
const hashSchema = z.string().trim().regex(/^[a-f0-9]{64}$/, 'value must be a lowercase SHA-256 hex digest')
const finiteNumberSchema = z.number().finite()
const nonNegativeNumberSchema = finiteNumberSchema.min(0)
const nonNegativeQuantitySchema = finiteNumberSchema.nonnegative()
const positiveIntegerSchema = z.number().finite().int().positive().refine(Number.isSafeInteger, 'value must be a safe integer')
const moneyArsSchema = z.number().finite().min(0).multipleOf(0.01)
const signedMoneyArsSchema = z.number().finite().multipleOf(0.01)

const isCivilDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

const isIsoDateTime = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false
  if (!isCivilDate(value.slice(0, 10))) return false
  return !Number.isNaN(new Date(value).getTime())
}

const civilDateSchema = z.string().refine(isCivilDate, 'value must be a civil date')
const isoDateTimeSchema = z.string().refine(isIsoDateTime, 'value must be an ISO date-time')

const hasUniqueValues = (values: string[]): boolean => new Set(values).size === values.length

const measureSchema = z.object({
  value: finiteNumberSchema.positive(),
  unit: unitSchema
}).strict()

const routeStopSchema = z.object({
  sequence: positiveIntegerSchema,
  clientId: objectIdSchema,
  saleIds: z.array(objectIdSchema).min(1).max(1000)
}).strict()

const routeVehicleSchema = z.object({
  vehicleCode: labelSchema,
  fuelConsumptionLitersPer100Km: finiteNumberSchema.positive()
}).strict()

const routeCapacitySchema = z.object({
  maxWeight: measureSchema,
  maxVolume: measureSchema
}).strict()

const simulationRouteSnapshotSchema = z.object({
  contractVersion: contractVersionSchema,
  capturedAt: isoDateTimeSchema,
  routeId: objectIdSchema,
  status: z.enum(Object.values(SIMULATION_ROUTE_SNAPSHOT_STATUSES) as [string, ...string[]]),
  zoneCode: labelSchema,
  stops: z.array(routeStopSchema).min(1).max(1000),
  distanceMeters: nonNegativeNumberSchema,
  durationSeconds: nonNegativeNumberSchema,
  vehicle: routeVehicleSchema,
  capacity: routeCapacitySchema,
  tollsArs: moneyArsSchema,
  parkingArs: moneyArsSchema
}).strict().superRefine((snapshot, ctx) => {
  if (!hasUniqueValues(snapshot.stops.map((stop) => String(stop.sequence)))) {
    ctx.addIssue({ code: 'custom', message: 'stop sequences must be unique', path: ['stops'] })
  }
  const saleIds = snapshot.stops.flatMap((stop) => stop.saleIds)
  if (!hasUniqueValues(saleIds)) {
    ctx.addIssue({ code: 'custom', message: 'sale identifiers must be unique across stops', path: ['stops'] })
  }
})

const stockProductSnapshotSchema = z.object({
  productId: objectIdSchema,
  availableQuantity: nonNegativeQuantitySchema,
  unitCostArs: moneyArsSchema,
  presalePriceArs: moneyArsSchema,
  weight: measureSchema,
  volume: measureSchema
}).strict()

const simulationStockSnapshotSchema = z.object({
  contractVersion: contractVersionSchema,
  capturedAt: isoDateTimeSchema,
  products: z.array(stockProductSnapshotSchema).min(1).max(10000)
}).strict().refine(
  (snapshot) => hasUniqueValues(snapshot.products.map((product) => product.productId)),
  { message: 'product identifiers must be unique', path: ['products'] }
)

const overrideSchema = z.object({
  key: boundedIdentifierSchema,
  value: nonNegativeNumberSchema
}).strict()

const overrideListSchema = z.array(overrideSchema).max(64).refine(
  (overrides) => hasUniqueValues(overrides.map((override) => override.key)),
  'override keys must be unique'
)

const directLoadLineSchema = z.object({
  productId: objectIdSchema,
  quantity: nonNegativeQuantitySchema,
  projectedSalesQuantity: nonNegativeQuantitySchema
}).strict().refine(
  (line) => line.projectedSalesQuantity <= line.quantity,
  { message: 'projected sales cannot exceed direct load', path: ['projectedSalesQuantity'] }
)

const directLoadListSchema = z.array(directLoadLineSchema).max(10000).refine(
  (lines) => hasUniqueValues(lines.map((line) => line.productId)),
  'product identifiers must be unique'
)

const simulationVariantInputSchema = z.object({
  name: labelSchema,
  presetVersionId: objectIdSchema.optional(),
  overrides: overrideListSchema,
  directLoad: directLoadListSchema
}).strict()

const calculationComponentSchema = z.object({
  code: boundedIdentifierSchema,
  amountArs: moneyArsSchema
}).strict()

const calculationTotalsSchema = z.object({
  revenueArs: moneyArsSchema,
  merchandiseCostArs: moneyArsSchema,
  operatingCostArs: moneyArsSchema,
  marginArs: signedMoneyArsSchema
}).strict()

const simulationCalculationResultSchema = z.object({
  baseScenarioHash: hashSchema,
  variantId: boundedIdentifierSchema,
  dataQuality: z.enum(Object.values(SIMULATION_DATA_QUALITY) as [string, ...string[]]),
  viability: z.enum(Object.values(SIMULATION_VIABILITY) as [string, ...string[]]),
  recommended: z.boolean(),
  risks: z.array(z.enum(Object.values(SIMULATION_RISK_CODES) as [string, ...string[]])).max(4).refine(
    (risks) => hasUniqueValues(risks),
    'risk codes must be unique'
  ),
  components: z.array(calculationComponentSchema).max(64).refine(
    (components) => hasUniqueValues(components.map((component) => component.code)),
    'component codes must be unique'
  ),
  totals: calculationTotalsSchema,
  calculatedAt: isoDateTimeSchema
}).strict().refine(
  (result) => !result.recommended || (result.dataQuality === SIMULATION_DATA_QUALITY.COMPLETE && result.viability === SIMULATION_VIABILITY.VIABLE),
  { message: 'only complete and viable variants can be recommended', path: ['recommended'] }
)

const calculationListSchema = z.array(simulationCalculationResultSchema).min(2).refine(
  (variants) => hasUniqueValues(variants.map((variant) => variant.variantId)),
  'variant identifiers must be unique'
)

const sameBaseScenario = (variants: Array<{ baseScenarioHash: string }>): boolean =>
  variants.every((variant) => variant.baseScenarioHash === variants[0]?.baseScenarioHash)

const simulationComparisonInputSchema = z.object({
  token: tokenSchema,
  variants: calculationListSchema
}).strict().refine(
  (input) => sameBaseScenario(input.variants),
  { message: 'all variants must share one base scenario', path: ['variants'] }
)

const simulationComparisonResultSchema = z.object({
  baseScenarioHash: hashSchema,
  variants: calculationListSchema,
  recommendedVariantId: z.string().trim().min(1).max(128).nullable()
}).strict().superRefine((result, ctx) => {
  if (!sameBaseScenario(result.variants)) {
    ctx.addIssue({ code: 'custom', message: 'all variants must share one base scenario', path: ['variants'] })
  }
  if (result.variants.some((variant) => variant.baseScenarioHash !== result.baseScenarioHash)) {
    ctx.addIssue({ code: 'custom', message: 'variant hashes must match the comparison hash', path: ['baseScenarioHash'] })
  }
  if (result.recommendedVariantId !== null && !result.variants.some((variant) => variant.variantId === result.recommendedVariantId)) {
    ctx.addIssue({ code: 'custom', message: 'recommended variant must belong to the comparison', path: ['recommendedVariantId'] })
  }
})

const simulationBaseScenarioInputSchema = z.object({
  routeId: objectIdSchema
}).strict()

const simulationSaveRunInputSchema = z.object({
  token: tokenSchema,
  variant: simulationVariantInputSchema
}).strict()

const approvalSchema = z.object({
  approvedBy: objectIdSchema,
  approvalId: boundedIdentifierSchema,
  approvedAt: isoDateTimeSchema
}).strict()

const periodSchema = z.object({
  from: civilDateSchema,
  to: civilDateSchema
}).strict().refine((period) => period.from <= period.to, {
  message: 'period.from must not be after period.to',
  path: ['from']
})

const numericValuesSchema = z.record(boundedIdentifierSchema, nonNegativeNumberSchema)

const simulationVersionedConfigurationInputSchema = z.object({
  vehicleCode: labelSchema,
  zoneCode: labelSchema,
  period: periodSchema,
  values: numericValuesSchema.refine((values) => Object.keys(values).length > 0, 'values must not be empty'),
  limits: numericValuesSchema,
  reason: reasonSchema,
  approval: approvalSchema
}).strict()

const presetDefinitionSchema = z.object({
  overrides: overrideListSchema,
  directLoad: directLoadListSchema
}).strict()

const simulationVersionedPresetInputSchema = z.object({
  name: labelSchema,
  definition: presetDefinitionSchema,
  reason: reasonSchema
}).strict()

const simulationErrorEnvelopeSchema = z.object({
  code: z.enum(Object.values(SIMULATION_ERROR_CODES) as [SimulationErrorCode, ...SimulationErrorCode[]]),
  message: z.string().trim().min(1).max(500),
  correlationId: z.string().trim().min(1).max(128).optional()
}).strict()

export {
  objectIdSchema,
  measureSchema,
  routeStopSchema,
  simulationRouteSnapshotSchema,
  simulationStockSnapshotSchema,
  overrideSchema,
  directLoadLineSchema,
  simulationVariantInputSchema,
  simulationCalculationResultSchema,
  simulationComparisonInputSchema,
  simulationComparisonResultSchema,
  simulationBaseScenarioInputSchema,
  simulationSaveRunInputSchema,
  periodSchema,
  simulationVersionedConfigurationInputSchema,
  numericValuesSchema as simulationNumericRecordSchema,
  presetDefinitionSchema,
  simulationVersionedPresetInputSchema,
  simulationErrorEnvelopeSchema
}
