import { expect } from 'chai'
import { createRequire } from 'module'

import { SIMULATION_CONTRACT_IDS, SIMULATION_DATA_QUALITY } from '../../src/interfaces/simulation.interface'
import {
  BASE_HASH,
  CAPTURED_AT,
  USER_ID,
  validCalculation,
  validRouteSnapshot,
  validRun,
  validStockSnapshot
} from './fixtures'

interface VerificationIndex {
  name: string
  key: Record<string, number>
  unique?: boolean
  expireAfterSeconds?: number
}

interface VerificationTarget {
  name: string
  indexes: VerificationIndex[]
}

interface VerificationResult {
  failures: string[]
  indexes: Array<{ collection: string, name: string }>
  runsChecked: number
  configurationsChecked: number
  presetsChecked: number
  snapshotHandlesChecked: number
  structuralValidationCheck: string
  modelImmutabilityCheck: string
}

interface VerificationModule {
  validateRun: (run: unknown, failures: string[]) => void
  validateSnapshotHandle: (handle: unknown, failures: string[]) => void
  verify: (db: unknown) => Promise<VerificationResult>
  TARGETS: VerificationTarget[]
}

interface PreflightConflict {
  collection: string
  index: string
  expected: VerificationIndex
  observed: VerificationIndex
  reason?: string
}

interface PreflightInventoryEntry {
  name: string
  exists: boolean
  count: number
  indexes: VerificationIndex[]
}

interface PreflightModule {
  TARGETS: VerificationTarget[]
  findIndexConflicts: (
    targets: VerificationTarget[],
    inventory: PreflightInventoryEntry[]
  ) => PreflightConflict[]
}

interface CollectionMigrationModule {
  TARGET_COLLECTIONS: string[]
}

const requireFromTest = createRequire(__filename)
const {
  validateRun,
  validateSnapshotHandle,
  verify,
  TARGETS
} = requireFromTest('../../migrations/simulation-004-verify.js') as VerificationModule

const EXPECTED_SIMULATION_INDEXES: VerificationTarget[] = [
  {
    name: 'simulationruns',
    indexes: [
      { name: 'idx_simulation_run_route_created', key: { sourceRouteId: 1, createdAt: -1 }, unique: false },
      { name: 'idx_simulation_run_status_created', key: { status: 1, createdAt: -1 }, unique: false }
    ]
  },
  {
    name: 'simulationconfigversions',
    indexes: [
      { name: 'idx_simulation_config_logical_version_unique', key: { vehicleCode: 1, zoneCode: 1, 'period.from': 1, 'period.to': 1, version: 1 }, unique: true },
      { name: 'idx_simulation_config_status_period', key: { status: 1, 'period.from': 1, 'period.to': 1 }, unique: false }
    ]
  },
  {
    name: 'simulationpresetversions',
    indexes: [
      { name: 'idx_simulation_preset_version_unique', key: { name: 1, version: 1 }, unique: true },
      { name: 'idx_simulation_preset_status_created', key: { status: 1, createdAt: -1 }, unique: false }
    ]
  },
  {
    name: 'simulationsnapshothandles',
    indexes: [
      { name: 'idx_simulation_snapshot_handle_digest_unique', key: { handleDigest: 1 }, unique: true },
      { name: 'idx_simulation_snapshot_handle_expires_ttl', key: { expiresAt: 1 }, unique: false, expireAfterSeconds: 0 }
    ]
  }
]

const handleRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  _id: USER_ID,
  handleDigest: 'b'.repeat(64),
  actorId: USER_ID,
  routeSnapshot: validRouteSnapshot,
  stockSnapshot: validStockSnapshot,
  versions: {
    routeContractVersion: SIMULATION_CONTRACT_IDS.ROUTE,
    stockContractVersion: SIMULATION_CONTRACT_IDS.STOCK,
    rulesVersion: 'simulation-rules-v1'
  },
  baseScenarioHash: BASE_HASH,
  issuedAt: new Date(CAPTURED_AT),
  expiresAt: new Date(Date.parse(CAPTURED_AT) + 15 * 60 * 1000),
  createdAt: new Date(CAPTURED_AT),
  updatedAt: new Date(CAPTURED_AT),
  ...overrides
})

const indexesOf = (collection: string): VerificationIndex[] => {
  const target = TARGETS.find((entry) => entry.name === collection)
  return target === undefined ? [] : target.indexes.map((index) => ({ ...index, key: { ...index.key } }))
}

const cursorOf = (documents: unknown[]): unknown => {
  let index = 0
  return {
    toArray: async () => {
      throw new Error('collection was materialized with toArray')
    },
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        if (index >= documents.length) return { done: true, value: undefined }
        const value = documents[index]
        index += 1
        return { done: false, value }
      }
    })
  }
}

const databaseWith = (
  documents: Record<string, unknown[]>,
  indexOverrides: Record<string, VerificationIndex[]> = {}
): unknown => ({
  listCollections: () => ({ toArray: async () => Object.keys(documents).map((name) => ({ name })) }),
  collection: (name: string) => ({
    indexes: async () => indexOverrides[name] ?? indexesOf(name),
    find: () => cursorOf(documents[name] ?? [])
  })
})

describe('Simulation migration - persisted structural verification', () => {
  const persistedRun = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    _id: USER_ID,
    ...validRun,
    createdBy: USER_ID,
    versions: { ...validRun.versions, calculatedAt: new Date(CAPTURED_AT) },
    ...overrides
  })

  it('TC-012: accepts structurally complete persisted evidence', () => {
    const failures: string[] = []
    validateRun(persistedRun(), failures)
    expect(failures).to.deep.equal([])
  })

  it('TC-012: rejects malformed persisted evidence consistently with model validation', () => {
    const emptyActor: string[] = []
    validateRun(persistedRun({ createdBy: '' }), emptyActor)
    expect(emptyActor).to.deep.equal([`Run ${USER_ID} has no actor evidence`])

    const malformedRoute: string[] = []
    validateRun(persistedRun({ routeSnapshot: { ...validRouteSnapshot, capacity: undefined } }), malformedRoute)
    expect(malformedRoute).to.deep.equal([`Run ${USER_ID} has an invalid route capacity`])

    const malformedStock: string[] = []
    validateRun(persistedRun({
      stockSnapshot: {
        ...validStockSnapshot,
        products: [{ ...validStockSnapshot.products[0], presalePriceArs: undefined }]
      }
    }), malformedStock)
    expect(malformedStock.some((failure) => failure.includes('invalid stock product'))).to.equal(true)

    const missingAmount: string[] = []
    validateRun(persistedRun({
      calculation: { ...validCalculation, components: [{ code: 'fuel' }] }
    }), missingAmount)
    expect(missingAmount.some((failure) => failure.includes('invalid calculation component'))).to.equal(true)

    const inconsistentRecommendation: string[] = []
    validateRun(persistedRun({
      calculation: { ...validCalculation, dataQuality: SIMULATION_DATA_QUALITY.INCOMPLETE }
    }), inconsistentRecommendation)
    expect(inconsistentRecommendation.some((failure) => failure.includes('recommends an incomplete or non-viable calculation'))).to.equal(true)
  })

  it('TC-012: rejects impossible civil dates in persisted evidence while accepting real leap-year dates', () => {
    const impossibleDay: string[] = []
    validateRun(persistedRun({
      routeSnapshot: { ...validRouteSnapshot, capturedAt: '2026-02-30T12:00:00.000Z' }
    }), impossibleDay)
    expect(impossibleDay.some((failure) => failure.includes('invalid route capture timestamp'))).to.equal(true)

    const impossibleMonthEnd: string[] = []
    validateRun(persistedRun({
      stockSnapshot: { ...validStockSnapshot, capturedAt: '2026-04-31T12:00:00.000Z' },
      calculation: { ...validCalculation, calculatedAt: '2026-02-29T12:00:00.000Z' }
    }), impossibleMonthEnd)
    expect(impossibleMonthEnd.some((failure) => failure.includes('invalid stock capture timestamp'))).to.equal(true)
    expect(impossibleMonthEnd.some((failure) => failure.includes('invalid calculation timestamp'))).to.equal(true)

    const leapDay: string[] = []
    validateRun(persistedRun({
      routeSnapshot: { ...validRouteSnapshot, capturedAt: '2024-02-29T12:00:00.000Z' },
      stockSnapshot: { ...validStockSnapshot, capturedAt: '2024-02-29T12:00:00.000Z' },
      calculation: { ...validCalculation, calculatedAt: '2024-02-29T12:00:00.000Z' }
    }), leapDay)
    expect(leapDay).to.deep.equal([])
  })

  it('TC-012: verifies a valid snapshot handle collection with zero failures', async () => {
    const documents: Record<string, unknown[]> = {
      simulationruns: [persistedRun()],
      simulationconfigversions: [],
      simulationpresetversions: [],
      simulationsnapshothandles: [handleRecord()]
    }

    const result = await verify(databaseWith(documents))

    expect(result.failures).to.deep.equal([])
    expect(result.snapshotHandlesChecked).to.equal(1)
    expect(result.indexes).to.have.lengthOf(8)
  })

  it('TC-012: accepts valid snapshot handle evidence and rejects missing or invalid fields', () => {
    const validFailures: string[] = []
    validateSnapshotHandle(handleRecord(), validFailures)
    expect(validFailures).to.deep.equal([])

    const cases: Array<{ label: string, record: Record<string, unknown>, expected: string }> = [
      { label: 'missing actor', record: handleRecord({ actorId: '' }), expected: 'no actor binding' },
      { label: 'invalid digest', record: handleRecord({ handleDigest: 'not-a-digest' }), expected: 'invalid digest' },
      { label: 'invalid hash', record: handleRecord({ baseScenarioHash: 'not-a-hash' }), expected: 'invalid base scenario hash' },
      { label: 'missing issuance', record: handleRecord({ issuedAt: undefined }), expected: 'no issuance timestamp' },
      { label: 'missing expiration', record: handleRecord({ expiresAt: undefined }), expected: 'no expiration timestamp' },
      {
        label: 'missing versions',
        record: handleRecord({ versions: undefined }),
        expected: 'no version evidence'
      },
      {
        label: 'mismatched route version',
        record: handleRecord({
          versions: {
            routeContractVersion: 'SIM-ROUTE-SNAPSHOT-002',
            stockContractVersion: SIMULATION_CONTRACT_IDS.STOCK,
            rulesVersion: 'simulation-rules-v1'
          }
        }),
        expected: 'mismatched route contract evidence'
      },
      {
        label: 'non-validated route',
        record: handleRecord({ routeSnapshot: { ...validRouteSnapshot, status: 'DRAFT' } }),
        expected: 'non-validated route snapshot'
      },
      {
        label: 'expiration before issuance',
        record: handleRecord({ expiresAt: new Date(CAPTURED_AT) }),
        expected: 'expiration that does not follow issuance'
      }
    ]

    for (const { label, record, expected } of cases) {
      const failures: string[] = []
      validateSnapshotHandle(record, failures)
      expect(failures.some((failure) => failure.includes(expected)), label).to.equal(true)
    }
  })

  it('SIM-001: shared route and stock failures identify snapshot handle evidence', () => {
    const routeFailures: string[] = []
    validateSnapshotHandle(handleRecord({
      routeSnapshot: { ...validRouteSnapshot, capacity: undefined }
    }), routeFailures)
    expect(routeFailures.some((failure) => {
      return failure.includes('Snapshot handle') &&
        failure.includes(USER_ID) &&
        failure.includes('invalid route capacity')
    })).to.equal(true)
    expect(routeFailures.every((failure) => !failure.startsWith('Run '))).to.equal(true)

    const stockFailures: string[] = []
    validateSnapshotHandle(handleRecord({
      stockSnapshot: {
        ...validStockSnapshot,
        products: [{ ...validStockSnapshot.products[0], presalePriceArs: undefined }]
      }
    }), stockFailures)
    expect(stockFailures.some((failure) => {
      return failure.includes('Snapshot handle') &&
        failure.includes(USER_ID) &&
        failure.includes('invalid stock product')
    })).to.equal(true)
    expect(stockFailures.every((failure) => !failure.startsWith('Run '))).to.equal(true)

    const validFailures: string[] = []
    validateSnapshotHandle(handleRecord(), validFailures)
    expect(validFailures).to.deep.equal([])
  })

  it('SIM-001: preflights all four simulation collections including snapshot handles', () => {
    const preflight = requireFromTest('../../migrations/simulation-001-preflight.js') as PreflightModule
    const verifyTarget = TARGETS.find((target) => target.name === 'simulationsnapshothandles')
    const preflightTarget = preflight.TARGETS.find((target) => target.name === 'simulationsnapshothandles')

    expect(preflight.TARGETS.map((target) => target.name)).to.deep.equal(TARGETS.map((target) => target.name))
    expect(preflightTarget?.indexes).to.deep.equal(verifyTarget?.indexes)
  })

  it('SIM-001: every migration agrees on the target collection set', () => {
    const preflight = requireFromTest('../../migrations/simulation-001-preflight.js') as PreflightModule
    const create = requireFromTest('../../migrations/simulation-002-create-collections.js') as CollectionMigrationModule
    const indexes = requireFromTest('../../migrations/simulation-003-create-indexes.js') as { TARGETS: VerificationTarget[] }
    const expectedTargets = [
      'simulationruns',
      'simulationconfigversions',
      'simulationpresetversions',
      'simulationsnapshothandles'
    ]

    expect(create.TARGET_COLLECTIONS).to.deep.equal(expectedTargets)
    expect(create.TARGET_COLLECTIONS).to.deep.equal(preflight.TARGETS.map((target) => target.name))
    expect(create.TARGET_COLLECTIONS).to.deep.equal(indexes.TARGETS.map((target) => target.name))
    expect(create.TARGET_COLLECTIONS).to.deep.equal(TARGETS.map((target) => target.name))
  })

  it('SIM-001: every migration publishes the exact named index definitions for all four collections', () => {
    const preflight = requireFromTest('../../migrations/simulation-001-preflight.js') as PreflightModule
    const indexes = requireFromTest('../../migrations/simulation-003-create-indexes.js') as { TARGETS: VerificationTarget[] }

    expect(preflight.TARGETS).to.deep.equal(EXPECTED_SIMULATION_INDEXES)
    expect(indexes.TARGETS).to.deep.equal(EXPECTED_SIMULATION_INDEXES)
    expect(TARGETS).to.deep.equal(EXPECTED_SIMULATION_INDEXES)
  })

  it('SIM-001: fails verification when the snapshot handle TTL index is missing', async () => {
    const documents: Record<string, unknown[]> = {
      simulationruns: [],
      simulationconfigversions: [],
      simulationpresetversions: [],
      simulationsnapshothandles: []
    }
    const handleIndexes = indexesOf('simulationsnapshothandles')
    const ttl = handleIndexes.find((index) => index.name === 'idx_simulation_snapshot_handle_expires_ttl')
    if (ttl === undefined) throw new Error('Missing snapshot handle TTL index target')

    const result = await verify(databaseWith(documents, {
      simulationsnapshothandles: handleIndexes.filter((index) => index.name !== ttl.name)
    }))

    expect(result.failures).to.deep.equal([
      `Missing index ${ttl.name} on simulationsnapshothandles`
    ])
  })

  it('SIM-001: fails verification when a same-name snapshot handle index drifts from the expected definition', async () => {
    const documents: Record<string, unknown[]> = {
      simulationruns: [],
      simulationconfigversions: [],
      simulationpresetversions: [],
      simulationsnapshothandles: []
    }
    const handleIndexes = indexesOf('simulationsnapshothandles')
    const ttl = handleIndexes.find((index) => index.name === 'idx_simulation_snapshot_handle_expires_ttl')
    if (ttl === undefined) throw new Error('Missing snapshot handle TTL index target')
    const drifted: VerificationIndex = { name: ttl.name, key: { expiresAt: 1 }, expireAfterSeconds: 3600 }

    const result = await verify(databaseWith(documents, {
      simulationsnapshothandles: handleIndexes.map((index) => index.name === ttl.name ? drifted : index)
    }))

    expect(result.failures).to.deep.equal([
      `Index ${ttl.name} on simulationsnapshothandles does not match the expected definition`
    ])
  })

  it('SIM-001: preflight rejects a same-key index under a different name', () => {
    const preflight = requireFromTest('../../migrations/simulation-001-preflight.js') as PreflightModule
    const target = preflight.TARGETS.find((entry) => entry.name === 'simulationruns')
    if (target === undefined) throw new Error('Missing simulationruns target')

    const [expected, ...otherIndexes] = target.indexes
    const legacy = { ...expected, name: 'legacy_idx_simulation_run_route_created' }
    const conflicts = preflight.findIndexConflicts(preflight.TARGETS, [{
      name: 'simulationruns',
      exists: true,
      count: 0,
      indexes: [legacy, ...otherIndexes]
    }])

    expect(conflicts).to.have.lengthOf(1)
    expect(conflicts[0].collection).to.equal('simulationruns')
    expect(conflicts[0].index).to.equal(expected.name)
    expect(conflicts[0].expected).to.deep.equal(expected)
    expect(conflicts[0].observed).to.deep.equal(legacy)
    expect(conflicts[0].reason).to.equal('the same index key already exists under a different name')
  })

  it('TC-013: iterates persisted collections incrementally instead of materializing them', async () => {
    const documents: Record<string, unknown[]> = {
      simulationruns: [persistedRun(), persistedRun({ _id: '507f1f77bcf86cd799439016' })],
      simulationconfigversions: [],
      simulationpresetversions: [],
      simulationsnapshothandles: []
    }

    const result = await verify(databaseWith(documents))
    expect(result.runsChecked).to.equal(2)
    expect(result.configurationsChecked).to.equal(0)
    expect(result.presetsChecked).to.equal(0)
    expect(result.snapshotHandlesChecked).to.equal(0)
  })
})
