import { expect } from 'chai'
import sinon from 'sinon'

import {
  SIMULATION_DATA_QUALITY,
  SIMULATION_ERROR_CODES,
  SIMULATION_RISK_CODES,
  SIMULATION_RULES_PROVISIONAL_V1,
  SIMULATION_VIABILITY,
  type SimulationSnapshotHandleVersions,
  type SimulationSnapshotHandle,
  type SimulationSnapshotHandleRepository,
  type SimulationVariantInput
} from '../../src/interfaces/simulation.interface'
import {
  simulationBaseScenarioResultSchema,
  simulationComparisonInputSchema,
  simulationVariantCalculationResultSchema
} from '../../src/schemas/simulation.schema'
import {
  SimulationSnapshotError,
  type ValidatedSnapshots
} from '../../src/services/simulationSnapshotAdapter'
import {
  SimulationTokenError,
  issueBaseScenarioToken,
  verifyBaseScenarioToken,
  type BaseScenarioTokenDependencies,
  type ValidatedBaseScenario
} from '../../src/services/simulationToken'
import {
  SimulationServiceError,
  calculateBaseScenarioHash,
  calculateVariant,
  canonicalizeSimulationValue,
  createBaseScenario,
  type SimulationBaseScenarioHashInput,
  type SimulationCalculationParameters,
  type SimulationServiceDependencies
} from '../../src/services/simulation'
import {
  calculateVariant as calculatePureVariant,
  compareVariants
} from '../../src/services/simulationRules'
import {
  PRODUCT_ID,
  ROUTE_ID,
  USER_ID,
  validCalculation,
  validRouteSnapshot,
  validStockSnapshot
} from './fixtures'

const TOKEN_SECRET = 'simulation-service-test-secret-01'
const FIXED_CLOCK = '2026-11-02T12:00:00.000Z'
// Golden SHA-256 of the canonical fixture, recorded independently of the assertion.
const CANONICAL_FIXTURE_HASH = 'eb9743bfa7a88ad19dad0463c6b5525eb93d3b33a0bf66a44c30293ed6c99d23'
const ISSUED_TOKEN = `sim2.${'a'.repeat(43)}.${'b'.repeat(43)}`
const PARAMETER_NAMES = [
  'fuelPriceArsPerLiter',
  'durationCostArsPerHour',
  'distanceCostArsPerKm'
] as const

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const fixedClock = (): Date => new Date(FIXED_CLOCK)

const objectId = (value: number): string => value.toString(16).padStart(24, '0')

class InMemoryHandleRepository implements SimulationSnapshotHandleRepository {
  readonly records = new Map<string, unknown>()
  insertCalls = 0
  findCalls = 0

  async insert (record: SimulationSnapshotHandle): Promise<void> {
    this.insertCalls += 1
    this.records.set(record.handleDigest, record)
  }

  async findByHandleDigest (handleDigest: string): Promise<unknown | null> {
    this.findCalls += 1
    return this.records.get(handleDigest) ?? null
  }
}

const snapshots = (): ValidatedSnapshots => ({
  routeSnapshot: clone(validRouteSnapshot),
  stockSnapshot: clone(validStockSnapshot)
})

const versions = (
  routeContractVersion = validRouteSnapshot.contractVersion,
  stockContractVersion = validStockSnapshot.contractVersion,
  rulesVersion = SIMULATION_RULES_PROVISIONAL_V1
): SimulationSnapshotHandleVersions => ({
  routeContractVersion,
  stockContractVersion,
  rulesVersion
})

const hashInput = (
  routeSnapshot = clone(validRouteSnapshot),
  stockSnapshot = clone(validStockSnapshot),
  rulesVersion = SIMULATION_RULES_PROVISIONAL_V1
): SimulationBaseScenarioHashInput => ({
  routeSnapshot,
  stockSnapshot,
  versions: versions(routeSnapshot.contractVersion, stockSnapshot.contractVersion, rulesVersion)
})

const validatedBaseScenario = (): ValidatedBaseScenario => {
  const frozen = snapshots()
  const baseVersions = versions()
  return {
    ...frozen,
    versions: baseVersions,
    baseScenarioHash: calculateBaseScenarioHash({
      ...frozen,
      versions: baseVersions
    })
  }
}

const dependencies = (
  overrides: Partial<SimulationServiceDependencies> = {}
): SimulationServiceDependencies => ({
  loadSnapshots: async () => snapshots(),
  issueBaseScenarioToken: async () => ISSUED_TOKEN,
  verifyBaseScenarioToken: async () => validatedBaseScenario(),
  clock: fixedClock,
  ...overrides
})

const calculationParameters = (): SimulationCalculationParameters => ({
  fuelPriceArsPerLiter: 100,
  durationCostArsPerHour: 100,
  distanceCostArsPerKm: 10
})

const completeVariant = (): SimulationVariantInput => ({
  name: 'Optimized',
  overrides: [],
  directLoad: [{
    productId: PRODUCT_ID,
    quantity: 20,
    projectedSalesQuantity: 20
  }]
})

const reverseKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reverseKeys)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const reversed: Record<string, unknown> = {}
    for (const key of Object.keys(record).reverse()) reversed[key] = reverseKeys(record[key])
    return reversed
  }
  return value
}

const captureServiceError = async (operation: () => Promise<unknown>): Promise<SimulationServiceError> => {
  try {
    await operation()
  } catch (error) {
    expect(error).to.be.instanceOf(SimulationServiceError)
    return error as SimulationServiceError
  }
  throw new Error('Expected the service operation to fail closed')
}

describe('Simulation service', () => {
  it('S-01: creates a complete base scenario, binds the canonical hash and issues the handle', async () => {
    const loadSnapshots = sinon.stub().resolves(snapshots())
    const issueBaseScenarioToken = sinon.stub().resolves(ISSUED_TOKEN)
    const result = await createBaseScenario(
      { routeId: ROUTE_ID },
      { actorId: USER_ID },
      dependencies({ loadSnapshots, issueBaseScenarioToken })
    )

    expect(result.dataQuality).to.equal(SIMULATION_DATA_QUALITY.COMPLETE)
    if (result.dataQuality !== SIMULATION_DATA_QUALITY.COMPLETE) throw new Error('Expected a complete base scenario')
    const complete = result

    const expectedHash = calculateBaseScenarioHash(hashInput())
    expect(complete.token).to.equal(ISSUED_TOKEN)
    expect(complete.baseScenarioHash).to.equal(expectedHash)
    expect(complete.baseScenarioHash).to.match(/^[a-f0-9]{64}$/)
    expect(complete.versions).to.deep.equal(versions())
    expect(complete.versions.rulesVersion).to.equal(SIMULATION_RULES_PROVISIONAL_V1)
    expect(loadSnapshots.calledOnceWith({ routeId: ROUTE_ID })).to.equal(true)
    expect(issueBaseScenarioToken.calledOnce).to.equal(true)
    expect(issueBaseScenarioToken.firstCall.args[0].baseScenarioHash).to.equal(expectedHash)
    expect(issueBaseScenarioToken.firstCall.args[1]).to.deep.equal({ actorId: USER_ID })
    expect(simulationBaseScenarioResultSchema.safeParse(complete).success).to.equal(true)
  })

  it('S-12: propagates an incomplete producer as an incomplete base scenario without issuing a handle', async () => {
    const issueBaseScenarioToken = sinon.stub().resolves(ISSUED_TOKEN)
    const result = await createBaseScenario(
      { routeId: ROUTE_ID },
      { actorId: USER_ID },
      dependencies({
        loadSnapshots: sinon.stub().rejects(new SimulationSnapshotError(
          SIMULATION_ERROR_CODES.SNAPSHOT_INCOMPLETE,
          'SIM-ROUTE-SNAPSHOT-001 snapshot is missing required field stops[0].saleIds',
          'stops[0].saleIds'
        )),
        issueBaseScenarioToken
      })
    )

    expect(result).to.deep.equal({
      dataQuality: SIMULATION_DATA_QUALITY.INCOMPLETE,
      error: {
        code: SIMULATION_ERROR_CODES.SNAPSHOT_INCOMPLETE,
        message: 'SIM-ROUTE-SNAPSHOT-001 snapshot is missing required field stops[0].saleIds'
      },
      missingField: 'stops[0].saleIds'
    })
    expect(issueBaseScenarioToken.called).to.equal(false)
    expect(simulationBaseScenarioResultSchema.safeParse(result).success).to.equal(true)
  })

  it('S-21: preserves the producer-unavailable code and skips token issuance when a producer is down', async () => {
    const issueBaseScenarioToken = sinon.stub().resolves(ISSUED_TOKEN)
    const result = await createBaseScenario(
      { routeId: ROUTE_ID },
      { actorId: USER_ID },
      dependencies({
        loadSnapshots: sinon.stub().rejects(new SimulationSnapshotError(
          SIMULATION_ERROR_CODES.PRODUCER_UNAVAILABLE,
          'Route snapshot producer is unavailable'
        )),
        issueBaseScenarioToken
      })
    )

    expect(result.dataQuality).to.equal(SIMULATION_DATA_QUALITY.INCOMPLETE)
    if (result.dataQuality !== SIMULATION_DATA_QUALITY.INCOMPLETE) throw new Error('Expected an incomplete base scenario')
    expect(result.error.code).to.equal(SIMULATION_ERROR_CODES.PRODUCER_UNAVAILABLE)
    expect(result.missingField).to.equal(undefined)
    expect(issueBaseScenarioToken.called).to.equal(false)
  })

  it('FR-028: preserves an unapproved-contract code instead of collapsing it into ordinary missing data', async () => {
    const issueBaseScenarioToken = sinon.stub().resolves(ISSUED_TOKEN)
    const result = await createBaseScenario(
      { routeId: ROUTE_ID },
      { actorId: USER_ID },
      dependencies({
        loadSnapshots: sinon.stub().rejects(new SimulationSnapshotError(
          SIMULATION_ERROR_CODES.CONTRACT_NOT_APPROVED,
          'SIM-ROUTE-SNAPSHOT-001 snapshot version v2 is not allowlisted'
        )),
        issueBaseScenarioToken
      })
    )

    expect(result.dataQuality).to.equal(SIMULATION_DATA_QUALITY.INCOMPLETE)
    if (result.dataQuality !== SIMULATION_DATA_QUALITY.INCOMPLETE) throw new Error('Expected an incomplete base scenario')
    expect(result.error.code).to.equal(SIMULATION_ERROR_CODES.CONTRACT_NOT_APPROVED)
    expect(result.error.message).to.equal('SIM-ROUTE-SNAPSHOT-001 snapshot version v2 is not allowlisted')
    expect(result.missingField).to.equal(undefined)
    expect(issueBaseScenarioToken.called).to.equal(false)
    expect(simulationBaseScenarioResultSchema.safeParse(result).success).to.equal(true)
  })

  it('NFR-003: produces one canonical SHA-256 hash regardless of object key insertion order', () => {
    const input = hashInput()
    const reordered = reverseKeys(input) as SimulationBaseScenarioHashInput

    expect(calculateBaseScenarioHash(input)).to.equal(CANONICAL_FIXTURE_HASH)
    expect(calculateBaseScenarioHash(reordered)).to.equal(CANONICAL_FIXTURE_HASH)
    expect(calculateBaseScenarioHash(input)).to.match(/^[a-f0-9]{64}$/)
  })

  it('NFR-003: changes the hash when a snapshot scalar, array order or version changes', () => {
    const route = clone(validRouteSnapshot)
    const secondStop = {
      sequence: 2,
      clientId: objectId(2),
      saleIds: [objectId(3)]
    }
    const twoStops = { ...route, stops: [...route.stops, secondStop] }
    const reorderedStops = { ...route, stops: [secondStop, ...route.stops] }
    const stock = clone(validStockSnapshot)

    expect(calculateBaseScenarioHash(hashInput(twoStops, stock)))
      .to.not.equal(calculateBaseScenarioHash(hashInput(reorderedStops, stock)))

    const original = hashInput(route, stock)
    const mutatedRoute = { ...route, tollsArs: route.tollsArs + 1 }
    expect(calculateBaseScenarioHash(hashInput(mutatedRoute, stock)))
      .to.not.equal(calculateBaseScenarioHash(original))

    expect(calculateBaseScenarioHash({
      ...original,
      versions: { ...original.versions, routeContractVersion: 'SIM-ROUTE-SNAPSHOT-002' }
    })).to.not.equal(calculateBaseScenarioHash(original))
    expect(calculateBaseScenarioHash({
      ...original,
      versions: { ...original.versions, stockContractVersion: 'SIM-STOCK-SNAPSHOT-002' }
    })).to.not.equal(calculateBaseScenarioHash(original))
    expect(calculateBaseScenarioHash(hashInput(route, stock, 'SIMULATION_RULES_PROVISIONAL_V2')))
      .to.not.equal(calculateBaseScenarioHash(original))
  })

  it('canonicalizes only plain data, preserves array order and rejects lossy or unsupported values', () => {
    expect(canonicalizeSimulationValue({ b: 1, a: [2, { d: 3, c: 4 }] }))
      .to.equal('{"a":[2,{"c":4,"d":3}],"b":1}')

    const input = { b: [3, 1], a: { d: 2, c: 1 } }
    const before = clone(input)
    canonicalizeSimulationValue(input)
    expect(input).to.deep.equal(before)

    class FixtureValue {
      readonly value = 1
    }

    const cycle: Record<string, unknown> = {}
    cycle.self = cycle

    const sparse: unknown[] = new Array(1)
    const invalidValues: Array<[string, unknown]> = [
      ['undefined object value', { value: undefined }],
      ['undefined array value', [undefined]],
      ['sparse array', sparse],
      ['non-finite number', { value: Number.NaN }],
      ['infinite number', [Number.POSITIVE_INFINITY]],
      ['date', { capturedAt: new Date(FIXED_CLOCK) }],
      ['class instance', { value: new FixtureValue() }],
      ['symbol key', { [Symbol('value')]: 1 }],
      ['non-enumerable key', Object.defineProperty({ visible: 1 }, 'hidden', { value: 2 })],
      ['cycle', cycle]
    ]

    for (const [label, value] of invalidValues) {
      expect(() => canonicalizeSimulationValue(value), label).to.throw()
    }
  })

  it('FR-010/FR-020/FR-027: composes existing pure helpers and leaves viability incomplete until capacity is assessed', async () => {
    const verifyBaseScenarioToken = sinon.stub().resolves(validatedBaseScenario())
    const result = await calculateVariant(
      ISSUED_TOKEN,
      completeVariant(),
      { actorId: USER_ID },
      dependencies({ verifyBaseScenarioToken, calculationParameters: calculationParameters() })
    )

    expect(result.dataQuality).to.equal(SIMULATION_DATA_QUALITY.COMPLETE)
    if (result.dataQuality !== SIMULATION_DATA_QUALITY.COMPLETE) throw new Error('Expected a complete calculation')
    expect(result.baseScenarioHash).to.equal(validatedBaseScenario().baseScenarioHash)
    expect(result.variantId).to.equal('Optimized')
    expect(result.viability).to.equal(SIMULATION_VIABILITY.INCOMPLETE)
    expect(result.viability).to.not.equal(SIMULATION_VIABILITY.VIABLE)
    expect(result.recommended).to.equal(false)
    expect(result.risks).to.deep.equal([])
    expect(result.totals).to.deep.equal({
      revenueArs: 3015,
      merchandiseCostArs: 2010,
      operatingCostArs: 825,
      marginArs: 180
    })
    expect(result.components).to.deep.equal([
      { code: 'fuel', amountArs: 125 },
      { code: 'duration', amountArs: 100 },
      { code: 'distance', amountArs: 100 },
      { code: 'tolls', amountArs: 500 },
      { code: 'parking', amountArs: 0 },
      { code: 'merchandise', amountArs: 2010 }
    ])
    expect(result.calculatedAt).to.equal(FIXED_CLOCK)
    expect(verifyBaseScenarioToken.calledOnceWith(ISSUED_TOKEN, { actorId: USER_ID })).to.equal(true)
    expect(simulationVariantCalculationResultSchema.safeParse(result).success).to.equal(true)
  })

  it('FR-030: marks a negative margin as NOT_VIABLE and never recommends it', async () => {
    const result = await calculateVariant(
      ISSUED_TOKEN,
      { name: 'Negative margin', overrides: [], directLoad: [] },
      { actorId: USER_ID },
      dependencies({ calculationParameters: calculationParameters() })
    )

    expect(result.dataQuality).to.equal(SIMULATION_DATA_QUALITY.COMPLETE)
    if (result.dataQuality !== SIMULATION_DATA_QUALITY.COMPLETE) throw new Error('Expected a complete calculation')
    expect(result.viability).to.equal(SIMULATION_VIABILITY.NOT_VIABLE)
    expect(result.recommended).to.equal(false)
    expect(result.risks).to.deep.equal([SIMULATION_RISK_CODES.NEGATIVE_MARGIN])
    expect(result.totals.marginArs).to.be.lessThan(0)
    expect(simulationVariantCalculationResultSchema.safeParse(result).success).to.equal(true)
  })

  it('Plan §7.3.2: the pure rules helper builds the result from plain values and the supplied timestamp', () => {
    const base = validatedBaseScenario()
    const result = calculatePureVariant(
      {
        baseScenarioHash: base.baseScenarioHash,
        routeSnapshot: base.routeSnapshot,
        stockSnapshot: base.stockSnapshot
      },
      completeVariant(),
      calculationParameters(),
      FIXED_CLOCK
    )

    expect(result.calculatedAt).to.equal(FIXED_CLOCK)
    expect(result.dataQuality).to.equal(SIMULATION_DATA_QUALITY.COMPLETE)
    expect(result.viability).to.equal(SIMULATION_VIABILITY.INCOMPLETE)
    expect(result.recommended).to.equal(false)
    expect(result.totals).to.deep.equal({
      revenueArs: 3015,
      merchandiseCostArs: 2010,
      operatingCostArs: 825,
      marginArs: 180
    })
  })

  it('FR-028: preserves distinct variant names without lossy identifier normalization', async () => {
    const verifyBaseScenarioToken = sinon.stub().resolves(validatedBaseScenario())
    const deps = dependencies({ verifyBaseScenarioToken, calculationParameters: calculationParameters() })
    const spaced = await calculateVariant(
      ISSUED_TOKEN,
      { ...completeVariant(), name: 'A B' },
      { actorId: USER_ID },
      deps
    )
    const underscored = await calculateVariant(
      ISSUED_TOKEN,
      { ...completeVariant(), name: 'A_B' },
      { actorId: USER_ID },
      deps
    )
    const trimmed = await calculateVariant(
      ISSUED_TOKEN,
      { ...completeVariant(), name: '  A B  ' },
      { actorId: USER_ID },
      deps
    )

    expect(spaced.variantId).to.equal('A B')
    expect(underscored.variantId).to.equal('A_B')
    expect(trimmed.variantId).to.equal('A B')
    expect(spaced.variantId).to.not.equal(underscored.variantId)
    expect(simulationVariantCalculationResultSchema.safeParse(spaced).success).to.equal(true)
    expect(simulationVariantCalculationResultSchema.safeParse(underscored).success).to.equal(true)
  })

  it('TC-030: rejects exact duplicate variant identifiers in comparison lists without collapsing distinct labels', () => {
    const spaced = { ...validCalculation, variantId: 'A B', recommended: false }
    const underscored = { ...validCalculation, variantId: 'A_B', recommended: false }
    const duplicate = { ...validCalculation, variantId: 'A B', recommended: false }

    expect(simulationComparisonInputSchema.safeParse({
      token: 'opaque-token',
      variants: [spaced, underscored]
    }).success).to.equal(true)
    expect(simulationComparisonInputSchema.safeParse({
      token: 'opaque-token',
      variants: [spaced, duplicate]
    }).success).to.equal(false)
  })

  it('FR-028: rejects contradictory complete and incomplete calculation shapes', () => {
    const incomplete = {
      baseScenarioHash: validCalculation.baseScenarioHash,
      variantId: 'Baseline',
      dataQuality: SIMULATION_DATA_QUALITY.INCOMPLETE,
      viability: SIMULATION_VIABILITY.INCOMPLETE,
      recommended: false,
      risks: [SIMULATION_RISK_CODES.INCOMPLETE_DATA],
      missingFields: ['fuelPriceArsPerLiter'],
      calculatedAt: FIXED_CLOCK
    }
    const completeWithoutTotals: Record<string, unknown> = { ...validCalculation }
    delete completeWithoutTotals.totals

    expect(simulationVariantCalculationResultSchema.safeParse(incomplete).success).to.equal(true)
    expect(simulationVariantCalculationResultSchema.safeParse({
      ...incomplete,
      totals: validCalculation.totals
    }).success).to.equal(false)
    expect(simulationVariantCalculationResultSchema.safeParse({
      ...incomplete,
      components: validCalculation.components
    }).success).to.equal(false)
    expect(simulationVariantCalculationResultSchema.safeParse(completeWithoutTotals).success).to.equal(false)
    expect(simulationVariantCalculationResultSchema.safeParse({
      ...validCalculation,
      viability: SIMULATION_VIABILITY.INCOMPLETE,
      recommended: false
    }).success).to.equal(true)
  })

  it('FR-029: compareVariants does not recommend a complete variant whose capacity is unassessed', () => {
    const unknownCapacity = {
      ...validCalculation,
      variantId: 'capacity-unknown',
      viability: SIMULATION_VIABILITY.INCOMPLETE,
      recommended: false
    }
    const viable = {
      ...validCalculation,
      variantId: 'capacity-assessed',
      recommended: false,
      totals: { ...validCalculation.totals, marginArs: 900 }
    }
    const notViable = { ...viable, viability: SIMULATION_VIABILITY.NOT_VIABLE }

    const comparison = compareVariants([unknownCapacity, viable])
    expect(comparison.recommendedVariantId).to.equal(viable.variantId)
    expect(comparison.variants.find((variant) => variant.variantId === unknownCapacity.variantId)?.recommended)
      .to.equal(false)
    expect(compareVariants([unknownCapacity, notViable]).recommendedVariantId).to.equal(null)
  })

  it('FR-028: returns an incomplete, non-recommendable variant with identified missing fields when calculation inputs are unavailable', async () => {
    const base = validatedBaseScenario()
    const verifyBaseScenarioToken = sinon.stub().resolves(base)
    const result = await calculateVariant(
      ISSUED_TOKEN,
      { ...completeVariant(), name: 'Baseline' },
      { actorId: USER_ID },
      dependencies({ verifyBaseScenarioToken })
    )

    expect(result.dataQuality).to.equal(SIMULATION_DATA_QUALITY.INCOMPLETE)
    if (result.dataQuality !== SIMULATION_DATA_QUALITY.INCOMPLETE) throw new Error('Expected an incomplete calculation')
    expect(result).to.deep.equal({
      baseScenarioHash: base.baseScenarioHash,
      variantId: 'Baseline',
      dataQuality: SIMULATION_DATA_QUALITY.INCOMPLETE,
      viability: SIMULATION_VIABILITY.INCOMPLETE,
      recommended: false,
      risks: [SIMULATION_RISK_CODES.INCOMPLETE_DATA],
      missingFields: [...PARAMETER_NAMES],
      calculatedAt: FIXED_CLOCK
    })
    expect(result).to.not.have.property('totals')
    expect(result).to.not.have.property('components')
    expect(simulationVariantCalculationResultSchema.safeParse(result).success).to.equal(true)
  })

  it('TC-030: rejects unsupported preset and override inputs instead of ignoring them', async () => {
    const unsupportedInputs: SimulationVariantInput[] = [
      { ...completeVariant(), presetVersionId: PRODUCT_ID },
      { ...completeVariant(), overrides: [{ key: 'fuelPricePerLiter', value: 1200.5 }] }
    ]

    for (const input of unsupportedInputs) {
      const verifyBaseScenarioToken = sinon.stub().resolves(validatedBaseScenario())
      const error = await captureServiceError(async () => await calculateVariant(
        ISSUED_TOKEN,
        input,
        { actorId: USER_ID },
        dependencies({ verifyBaseScenarioToken, calculationParameters: calculationParameters() })
      ))

      expect(error.code).to.equal(SIMULATION_ERROR_CODES.INPUT_INVALID)
      expect(verifyBaseScenarioToken.called).to.equal(false)
    }
  })

  it('TC-011: calculate reuses the bound snapshot and adds no repository writes or producer reads', async () => {
    const repository = new InMemoryHandleRepository()
    const tokenDependencies: BaseScenarioTokenDependencies = {
      secret: TOKEN_SECRET,
      clock: fixedClock,
      repository,
      routeContractAllowlist: [validRouteSnapshot.contractVersion],
      stockContractAllowlist: [validStockSnapshot.contractVersion]
    }
    const loadSnapshots = sinon.stub().resolves(snapshots())
    const serviceDependencies: SimulationServiceDependencies = {
      loadSnapshots,
      issueBaseScenarioToken: async (base, context) => await issueBaseScenarioToken(base, context, tokenDependencies),
      verifyBaseScenarioToken: async (token, context) => await verifyBaseScenarioToken(token, context, tokenDependencies),
      calculationParameters: calculationParameters(),
      clock: fixedClock
    }

    const created = await createBaseScenario({ routeId: ROUTE_ID }, { actorId: USER_ID }, serviceDependencies)
    expect(created.dataQuality).to.equal(SIMULATION_DATA_QUALITY.COMPLETE)
    if (created.dataQuality !== SIMULATION_DATA_QUALITY.COMPLETE) throw new Error('Expected a complete base scenario')
    expect(repository.insertCalls).to.equal(1)
    expect(repository.findCalls).to.equal(0)
    expect(loadSnapshots.calledOnce).to.equal(true)

    const calculated = await calculateVariant(
      created.token,
      completeVariant(),
      { actorId: USER_ID },
      serviceDependencies
    )

    expect(calculated.dataQuality).to.equal(SIMULATION_DATA_QUALITY.COMPLETE)
    expect(repository.insertCalls).to.equal(1)
    expect(repository.findCalls).to.equal(1)
    expect(repository.records.size).to.equal(1)
    expect(loadSnapshots.calledOnce).to.equal(true)
  })

  it('TC-030: rejects invalid request payloads with the declared input error before side effects', async () => {
    const loadSnapshots = sinon.stub().resolves(snapshots())
    const createError = await captureServiceError(async () => await createBaseScenario(
      { routeId: 'not-an-object-id' },
      { actorId: USER_ID },
      dependencies({ loadSnapshots })
    ))
    expect(createError.code).to.equal(SIMULATION_ERROR_CODES.INPUT_INVALID)
    expect(loadSnapshots.called).to.equal(false)

    const verifyBaseScenarioToken = sinon.stub().resolves(validatedBaseScenario())
    const invalidVariant = { name: '', overrides: [], directLoad: [] } as unknown as SimulationVariantInput
    const calculateError = await captureServiceError(async () => await calculateVariant(
      ISSUED_TOKEN,
      invalidVariant,
      { actorId: USER_ID },
      dependencies({ verifyBaseScenarioToken })
    ))
    expect(calculateError.code).to.equal(SIMULATION_ERROR_CODES.INPUT_INVALID)
    expect(verifyBaseScenarioToken.called).to.equal(false)
  })

  it('preserves declared token errors instead of rewriting their codes', async () => {
    const verifyBaseScenarioToken = sinon.stub().rejects(new SimulationTokenError(
      SIMULATION_ERROR_CODES.TOKEN_EXPIRED,
      'Base scenario handle has expired'
    ))
    const error = await captureServiceError(async () => await calculateVariant(
      ISSUED_TOKEN,
      completeVariant(),
      { actorId: USER_ID },
      dependencies({ verifyBaseScenarioToken })
    ))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.TOKEN_EXPIRED)
  })

  it('derives calculation timestamps from the injected clock deterministically', async () => {
    const clock = { now: new Date(FIXED_CLOCK) }
    const result = await calculateVariant(
      ISSUED_TOKEN,
      completeVariant(),
      { actorId: USER_ID },
      dependencies({ clock: () => clock.now })
    )

    expect(result.calculatedAt).to.equal(FIXED_CLOCK)
    clock.now = new Date('2026-11-02T12:00:01.000Z')
    const next = await calculateVariant(
      ISSUED_TOKEN,
      completeVariant(),
      { actorId: USER_ID },
      dependencies({ clock: () => clock.now })
    )
    expect(next.calculatedAt).to.equal('2026-11-02T12:00:01.000Z')
  })
})
