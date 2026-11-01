import {
  SIMULATION_DATA_QUALITY,
  SIMULATION_VIABILITY,
  type SimulationCalculationResult,
  type SimulationComparisonResult,
  type SimulationDirectLoadLine,
  type SimulationStockSnapshot
} from '../interfaces/simulation.interface'

interface FuelCostInput {
  distanceMeters: number
  consumptionLitersPer100Km: number
  priceArsPerLiter: number
}

interface DirectLoadTotals {
  revenueArs: number
  merchandiseCostArs: number
}

const assertFiniteNonNegative = (value: number, name: string): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`)
  }
}

export const roundCommercialAmount = (value: number): number => {
  if (!Number.isFinite(value)) throw new RangeError('amount must be finite')
  const sign = Math.sign(value)
  return sign * Math.round((Math.abs(value) + Number.EPSILON) * 100) / 100
}

export const calculateFuelCostArs = ({
  distanceMeters,
  consumptionLitersPer100Km,
  priceArsPerLiter
}: FuelCostInput): number => {
  assertFiniteNonNegative(distanceMeters, 'distanceMeters')
  assertFiniteNonNegative(consumptionLitersPer100Km, 'consumptionLitersPer100Km')
  assertFiniteNonNegative(priceArsPerLiter, 'priceArsPerLiter')
  return roundCommercialAmount(
    (distanceMeters / 1000) * (consumptionLitersPer100Km / 100) * priceArsPerLiter
  )
}

export const calculateDurationBasedCostArs = (durationSeconds: number, rateArsPerHour: number): number => {
  assertFiniteNonNegative(durationSeconds, 'durationSeconds')
  assertFiniteNonNegative(rateArsPerHour, 'rateArsPerHour')
  return roundCommercialAmount((durationSeconds / 3600) * rateArsPerHour)
}

export const calculateDistanceBasedCostArs = (distanceMeters: number, rateArsPerKm: number): number => {
  assertFiniteNonNegative(distanceMeters, 'distanceMeters')
  assertFiniteNonNegative(rateArsPerKm, 'rateArsPerKm')
  return roundCommercialAmount((distanceMeters / 1000) * rateArsPerKm)
}

export const calculateDirectLoadTotals = (
  stockSnapshot: SimulationStockSnapshot,
  directLoad: SimulationDirectLoadLine[]
): DirectLoadTotals => {
  let revenueArs = 0
  let merchandiseCostArs = 0

  for (const line of directLoad) {
    assertFiniteNonNegative(line.quantity, 'quantity')
    assertFiniteNonNegative(line.projectedSalesQuantity, 'projectedSalesQuantity')
    if (line.projectedSalesQuantity > line.quantity) {
      throw new RangeError('projected sales quantity cannot exceed direct load quantity')
    }

    const product = stockSnapshot.products.find(({ productId }) => productId === line.productId)
    if (product === undefined) throw new RangeError(`product ${line.productId} is missing from the stock snapshot`)
    if (line.quantity > product.availableQuantity) {
      throw new RangeError(`direct load quantity exceeds availability for product ${line.productId}`)
    }

    revenueArs += roundCommercialAmount(line.projectedSalesQuantity * product.presalePriceArs)
    merchandiseCostArs += roundCommercialAmount(line.projectedSalesQuantity * product.unitCostArs)
  }

  return {
    revenueArs: roundCommercialAmount(revenueArs),
    merchandiseCostArs: roundCommercialAmount(merchandiseCostArs)
  }
}

export const compareVariants = (variants: SimulationCalculationResult[]): SimulationComparisonResult => {
  if (variants.length < 2) throw new RangeError('at least two variants are required for comparison')

  const baseScenarioHash = variants[0].baseScenarioHash
  const variantIds = new Set<string>()
  for (const variant of variants) {
    if (variant.baseScenarioHash !== baseScenarioHash) {
      throw new RangeError('all variants must share one base scenario')
    }
    if (variantIds.has(variant.variantId)) throw new RangeError('variant identifiers must be unique')
    variantIds.add(variant.variantId)
  }

  const eligible = variants.filter((variant) =>
    variant.dataQuality === SIMULATION_DATA_QUALITY.COMPLETE &&
    variant.viability === SIMULATION_VIABILITY.VIABLE
  )
  const sorted = [...eligible].sort((left, right) => {
    const marginDifference = right.totals.marginArs - left.totals.marginArs
    if (marginDifference !== 0) return marginDifference
    return left.totals.operatingCostArs - right.totals.operatingCostArs
  })
  const top = sorted[0]
  const runnerUp = sorted[1]
  let winner: SimulationCalculationResult | undefined
  if (
    top !== undefined &&
    (runnerUp === undefined ||
      top.totals.marginArs !== runnerUp.totals.marginArs ||
      top.totals.operatingCostArs !== runnerUp.totals.operatingCostArs)
  ) {
    winner = top
  }

  const results = variants.map((variant) => ({
    ...variant,
    recommended: winner?.variantId === variant.variantId
  }))

  return {
    baseScenarioHash,
    variants: results,
    recommendedVariantId: winner?.variantId ?? null
  }
}
