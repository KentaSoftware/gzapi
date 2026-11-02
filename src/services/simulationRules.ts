import {
  SIMULATION_DATA_QUALITY,
  SIMULATION_RISK_CODES,
  SIMULATION_VIABILITY,
  type SimulationCalculationParameters,
  type SimulationCalculationResult,
  type SimulationComparisonResult,
  type SimulationDirectLoadLine,
  type SimulationIncompleteCalculationResult,
  type SimulationRiskCode,
  type SimulationStockSnapshot,
  type SimulationVariantCalculationBase,
  type SimulationVariantInput
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

// FR-028 result construction for missing required calculation inputs. The caller
// supplies the identified fields; no component or total is fabricated.
export const buildIncompleteCalculation = (
  baseScenarioHash: string,
  variantId: string,
  missingFields: string[],
  calculatedAt: string
): SimulationIncompleteCalculationResult => ({
  baseScenarioHash,
  variantId,
  dataQuality: SIMULATION_DATA_QUALITY.INCOMPLETE,
  viability: SIMULATION_VIABILITY.INCOMPLETE,
  recommended: false,
  risks: [SIMULATION_RISK_CODES.INCOMPLETE_DATA],
  missingFields: [...missingFields],
  calculatedAt
})

// Plan §7.3.2 pure calculation: no I/O, no clock read and no mutation. The service
// verifies the handle and supplies validated snapshots, provisional parameters and
// the injected timestamp. Capacity has no approved evaluator or threshold, so a
// non-negative margin is not evidence of viability and the result stays INCOMPLETE.
export const calculateVariant = (
  base: SimulationVariantCalculationBase,
  input: SimulationVariantInput,
  parameters: SimulationCalculationParameters,
  calculatedAt: string
): SimulationCalculationResult => {
  const directLoad = calculateDirectLoadTotals(base.stockSnapshot, input.directLoad)
  const fuelArs = calculateFuelCostArs({
    distanceMeters: base.routeSnapshot.distanceMeters,
    consumptionLitersPer100Km: base.routeSnapshot.vehicle.fuelConsumptionLitersPer100Km,
    priceArsPerLiter: parameters.fuelPriceArsPerLiter
  })
  const durationArs = calculateDurationBasedCostArs(
    base.routeSnapshot.durationSeconds,
    parameters.durationCostArsPerHour
  )
  const distanceArs = calculateDistanceBasedCostArs(
    base.routeSnapshot.distanceMeters,
    parameters.distanceCostArsPerKm
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

  return {
    baseScenarioHash: base.baseScenarioHash,
    variantId: input.name,
    dataQuality: SIMULATION_DATA_QUALITY.COMPLETE,
    viability: negativeMargin ? SIMULATION_VIABILITY.NOT_VIABLE : SIMULATION_VIABILITY.INCOMPLETE,
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
