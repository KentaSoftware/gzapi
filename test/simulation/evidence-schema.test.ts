import { expect } from 'chai'

import {
  SIMULATION_DATA_QUALITY,
  SIMULATION_RISK_CODES,
  SIMULATION_VIABILITY
} from '../../src/interfaces/simulation.interface'
import {
  simulationCalculationResultSchema,
  simulationComparisonInputSchema,
  simulationComparisonResultSchema,
  simulationRouteSnapshotSchema,
  simulationStockSnapshotSchema
} from '../../src/schemas/simulation.schema'
import {
  BASE_HASH,
  CLIENT_ID,
  SALE_ID,
  validCalculation,
  validRouteSnapshot,
  validStockSnapshot
} from './fixtures'

describe('Simulation contract - evidence schemas', () => {
  it('TC-030: validates versioned route snapshots with frozen orders and capacity', () => {
    expect(simulationRouteSnapshotSchema.safeParse(validRouteSnapshot).success).to.equal(true)
    expect(simulationRouteSnapshotSchema.safeParse({
      ...validRouteSnapshot,
      status: 'UNKNOWN'
    }).success).to.equal(false)
    expect(simulationRouteSnapshotSchema.safeParse({
      ...validRouteSnapshot,
      distanceMeters: -1
    }).success).to.equal(false)
    expect(simulationRouteSnapshotSchema.safeParse({
      ...validRouteSnapshot,
      stops: [
        validRouteSnapshot.stops[0],
        { sequence: 2, clientId: CLIENT_ID, saleIds: [SALE_ID] }
      ]
    }).success).to.equal(false)
    expect(simulationRouteSnapshotSchema.safeParse({
      ...validRouteSnapshot,
      capacity: undefined
    }).success).to.equal(false)
  })

  it('TC-030: validates versioned stock snapshots with frozen prices and measures', () => {
    expect(simulationStockSnapshotSchema.safeParse(validStockSnapshot).success).to.equal(true)
    expect(simulationStockSnapshotSchema.safeParse({
      ...validStockSnapshot,
      products: [validStockSnapshot.products[0], validStockSnapshot.products[0]]
    }).success).to.equal(false)
    expect(simulationStockSnapshotSchema.safeParse({
      ...validStockSnapshot,
      products: [{ ...validStockSnapshot.products[0], availableQuantity: 0.5 }]
    }).success).to.equal(true)
    expect(simulationStockSnapshotSchema.safeParse({
      ...validStockSnapshot,
      products: [{ ...validStockSnapshot.products[0], availableQuantity: -1 }]
    }).success).to.equal(false)
    expect(simulationStockSnapshotSchema.safeParse({
      ...validStockSnapshot,
      products: [{ ...validStockSnapshot.products[0], presalePriceArs: 10.999 }]
    }).success).to.equal(false)
  })

  it('TC-030: enforces two-decimal amounts and recommendation consistency', () => {
    expect(simulationCalculationResultSchema.safeParse(validCalculation).success).to.equal(true)
    expect(simulationCalculationResultSchema.safeParse({
      ...validCalculation,
      components: [{ code: 'fuel', amountArs: 10.999 }]
    }).success).to.equal(false)
    expect(simulationCalculationResultSchema.safeParse({
      ...validCalculation,
      calculatedAt: '2026-02-30T12:00:00.000Z'
    }).success).to.equal(false)
    expect(simulationCalculationResultSchema.safeParse({
      ...validCalculation,
      dataQuality: SIMULATION_DATA_QUALITY.INCOMPLETE
    }).success).to.equal(false)
    expect(simulationCalculationResultSchema.safeParse({
      ...validCalculation,
      viability: SIMULATION_VIABILITY.NOT_VIABLE
    }).success).to.equal(false)
    expect(simulationCalculationResultSchema.safeParse({
      ...validCalculation,
      risks: [SIMULATION_RISK_CODES.NEGATIVE_MARGIN]
    }).success).to.equal(true)
  })

  it('TC-030: requires compared variants to share one base scenario hash', () => {
    const second = { ...validCalculation, variantId: 'variant-conservative', recommended: false }
    expect(simulationComparisonInputSchema.safeParse({
      token: 'opaque-token',
      variants: [validCalculation, second]
    }).success).to.equal(true)
    expect(simulationComparisonInputSchema.safeParse({
      token: 'opaque-token',
      variants: [validCalculation]
    }).success).to.equal(false)
    expect(simulationComparisonInputSchema.safeParse({
      token: 'opaque-token',
      variants: [validCalculation, { ...second, baseScenarioHash: 'b'.repeat(64) }]
    }).success).to.equal(false)
    expect(simulationComparisonInputSchema.safeParse({
      token: 'opaque-token',
      variants: [validCalculation, { ...second, variantId: 'variant-optimized' }]
    }).success).to.equal(false)
    expect(simulationComparisonResultSchema.safeParse({
      baseScenarioHash: BASE_HASH,
      variants: [validCalculation, second],
      recommendedVariantId: 'variant-optimized'
    }).success).to.equal(true)
    expect(simulationComparisonResultSchema.safeParse({
      baseScenarioHash: BASE_HASH,
      variants: [validCalculation, second],
      recommendedVariantId: 'variant-missing'
    }).success).to.equal(false)
  })
})
