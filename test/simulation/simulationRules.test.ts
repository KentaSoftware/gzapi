import { expect } from 'chai'

import {
  SIMULATION_DATA_QUALITY,
  SIMULATION_VIABILITY
} from '../../src/interfaces/simulation.interface'
import {
  calculateDirectLoadTotals,
  calculateDistanceBasedCostArs,
  calculateDurationBasedCostArs,
  calculateFuelCostArs,
  compareVariants,
  roundCommercialAmount
} from '../../src/services/simulationRules'
import {
  PRODUCT_ID,
  validCalculation,
  validStockSnapshot
} from './fixtures'

describe('Simulation pure rules', () => {
  it('S-16: rounds commercial amounts to two decimals using half-up behavior', () => {
    expect(roundCommercialAmount(1.005)).to.equal(1.01)
    expect(roundCommercialAmount(1.004)).to.equal(1)
    expect(roundCommercialAmount(0)).to.equal(0)
    expect(() => roundCommercialAmount(Number.POSITIVE_INFINITY)).to.throw(RangeError)
  })

  it('S-16a: calculates fuel cost from frozen route consumption and an explicit price', () => {
    expect(calculateFuelCostArs({
      distanceMeters: 10000,
      consumptionLitersPer100Km: 12.5,
      priceArsPerLiter: 1200.5
    })).to.equal(1500.63)
  })

  it('S-16b: calculates duration and distance based costs without supplying defaults', () => {
    expect(calculateDurationBasedCostArs(3600, 1000)).to.equal(1000)
    expect(calculateDistanceBasedCostArs(10000, 10)).to.equal(100)
    expect(() => calculateDurationBasedCostArs(3600, Number.NaN)).to.throw(RangeError)
  })

  it('S-16h: calculates direct-sale revenue and merchandise cost from frozen stock prices', () => {
    const result = calculateDirectLoadTotals(validStockSnapshot, [{
      productId: PRODUCT_ID,
      quantity: 10,
      projectedSalesQuantity: 8
    }])

    expect(result).to.deep.equal({ revenueArs: 1206, merchandiseCostArs: 804 })
  })

  it('S-10: rejects direct load above frozen availability', () => {
    expect(() => calculateDirectLoadTotals(validStockSnapshot, [{
      productId: PRODUCT_ID,
      quantity: 21,
      projectedSalesQuantity: 8
    }])).to.throw(RangeError)
  })

  it('S-03: recommends the viable complete variant with highest margin', () => {
    const lowerMargin = {
      ...validCalculation,
      variantId: 'variant-lower-margin',
      recommended: false,
      totals: { ...validCalculation.totals, marginArs: 800 }
    }
    const comparison = compareVariants([lowerMargin, validCalculation])

    expect(comparison.recommendedVariantId).to.equal(validCalculation.variantId)
    expect(comparison.variants.find((variant) => variant.variantId === validCalculation.variantId)?.recommended).to.equal(true)
    expect(comparison.variants.find((variant) => variant.variantId === lowerMargin.variantId)?.recommended).to.equal(false)
  })

  it('S-03a: breaks equal-margin ties by lower operating cost', () => {
    const higherCost = {
      ...validCalculation,
      variantId: 'variant-higher-cost',
      recommended: false,
      totals: { ...validCalculation.totals, marginArs: 850, operatingCostArs: 70 }
    }
    const comparison = compareVariants([higherCost, validCalculation])

    expect(comparison.recommendedVariantId).to.equal(validCalculation.variantId)
  })

  it('S-03b: does not recommend when no complete viable variant exists', () => {
    const incomplete = {
      ...validCalculation,
      variantId: 'variant-incomplete',
      dataQuality: SIMULATION_DATA_QUALITY.INCOMPLETE,
      viability: SIMULATION_VIABILITY.INCOMPLETE,
      recommended: false
    }
    const notViable = {
      ...validCalculation,
      variantId: 'variant-not-viable',
      viability: SIMULATION_VIABILITY.NOT_VIABLE,
      recommended: false
    }

    expect(compareVariants([incomplete, notViable]).recommendedVariantId).to.equal(null)
  })

  it('S-03c: rejects comparison results from different base scenarios', () => {
    expect(() => compareVariants([
      validCalculation,
      { ...validCalculation, variantId: 'variant-other-base', baseScenarioHash: 'b'.repeat(64) }
    ])).to.throw(RangeError)
  })

  it('S-03d: leaves an exact tie unresolved instead of choosing arbitrarily', () => {
    const exactTie = { ...validCalculation, variantId: 'variant-exact-tie', recommended: false }

    expect(compareVariants([validCalculation, exactTie]).recommendedVariantId).to.equal(null)
  })
})
