import { expect } from 'chai'
import { createRequire } from 'module'

interface MigrationIndex {
  name: string
  key: Record<string, number>
  unique?: boolean
  expireAfterSeconds?: number
}

interface MigrationTarget {
  name: string
  indexes: MigrationIndex[]
}

interface IndexConflict {
  collection: string
  index: string
  expected: MigrationIndex
  observed: MigrationIndex
  reason?: string
}

interface PlannedIndex {
  collection: string
  index: MigrationIndex
}

interface IndexPlan {
  planned: PlannedIndex[]
  skipped: Array<{ collection: string, index: string }>
  conflicts: IndexConflict[]
}

interface ApplyResult {
  created: Array<{ collection: string, index: string }>
  skipped: Array<{ collection: string, index: string }>
  conflicts: IndexConflict[]
  plannedBeforeCreate: Array<{ collection: string, index: string }>
}

interface MigrationModule {
  TARGETS: MigrationTarget[]
  planIndexes: (db: unknown) => Promise<IndexPlan>
  applyIndexes: (db: unknown) => Promise<ApplyResult>
}

const requireFromTest = createRequire(__filename)
const {
  TARGETS,
  planIndexes,
  applyIndexes
} = requireFromTest('../../migrations/simulation-003-create-indexes.js') as MigrationModule

const expectedIndexes = (collection: string): MigrationIndex[] => {
  const target = TARGETS.find((entry) => entry.name === collection)
  if (target === undefined) throw new Error(`Missing test target ${collection}`)
  return target.indexes.map((index) => ({ ...index, key: { ...index.key } }))
}

const allExpectedIndexes = (): Record<string, MigrationIndex[]> => {
  return Object.fromEntries(TARGETS.map((target) => [target.name, expectedIndexes(target.name)]))
}

const offlineDatabase = (
  indexesByCollection: Record<string, MigrationIndex[]>,
  allowCreates = false
): {
  createCalls: string[]
  db: unknown
} => {
  const createCalls: string[] = []
  return {
    createCalls,
    db: {
      listCollections: () => ({
        toArray: async () => TARGETS.map((target) => ({ name: target.name }))
      }),
      collection: (name: string) => ({
        indexes: async () => indexesByCollection[name] ?? [],
        createIndexes: async (indexes: MigrationIndex[]) => {
          createCalls.push(...indexes.map((index) => `${name}.${index.name}`))
          if (!allowCreates) throw new Error('createIndexes must never run while a conflict is pending')
        }
      })
    }
  }
}

const conflictScenario = (): {
  indexes: Record<string, MigrationIndex[]>
  conflicting: MigrationIndex
  legacy: MigrationIndex
  pending: PlannedIndex
} => {
  const indexes = allExpectedIndexes()
  const [first, ...rest] = indexes.simulationruns
  const legacy = { ...first, name: 'legacy_idx_simulation_run_route_created' }
  indexes.simulationruns = [legacy, ...rest]

  const [pendingIndex, ...remainingPresets] = indexes.simulationpresetversions
  indexes.simulationpresetversions = remainingPresets

  return {
    indexes,
    conflicting: first,
    legacy,
    pending: { collection: 'simulationpresetversions', index: pendingIndex }
  }
}

describe('Simulation migration - index conflict preflight', () => {
  it('detects the same key under a different name and blocks every pending creation', async () => {
    const { indexes, conflicting, legacy, pending } = conflictScenario()

    const { db, createCalls } = offlineDatabase(indexes)
    const plan = await planIndexes(db)
    const result = await applyIndexes(db)

    expect(plan.planned).to.deep.equal([pending])
    expect(plan.conflicts).to.have.lengthOf(1)
    expect(result.conflicts).to.have.lengthOf(1)
    expect(result.plannedBeforeCreate).to.deep.equal([
      { collection: pending.collection, index: pending.index.name }
    ])
    expect(result.created).to.deep.equal([])
    expect(createCalls).to.deep.equal([])

    const conflict = result.conflicts[0]
    expect(conflict.collection).to.equal('simulationruns')
    expect(conflict.index).to.equal(conflicting.name)
    expect(conflict.expected).to.deep.equal(conflicting)
    expect(conflict.observed).to.deep.equal(legacy)
    expect(conflict.reason).to.equal('the same index key already exists under a different name')
  })

  it('creates the pending index when the same plan has no conflict', async () => {
    const { indexes, pending } = conflictScenario()
    indexes.simulationruns = allExpectedIndexes().simulationruns

    const { db, createCalls } = offlineDatabase(indexes, true)
    const result = await applyIndexes(db)

    expect(result.conflicts).to.deep.equal([])
    expect(result.plannedBeforeCreate).to.deep.equal([
      { collection: pending.collection, index: pending.index.name }
    ])
    expect(result.created).to.deep.equal([
      { collection: pending.collection, index: pending.index.name }
    ])
    expect(createCalls).to.deep.equal([`${pending.collection}.${pending.index.name}`])
  })

  it('keeps the expected-name behavior by skipping matching indexes', async () => {
    const { db, createCalls } = offlineDatabase(allExpectedIndexes())

    const result = await applyIndexes(db)

    expect(result.conflicts).to.deep.equal([])
    expect(result.created).to.deep.equal([])
    expect(result.skipped).to.have.lengthOf(TARGETS.reduce((total, target) => total + target.indexes.length, 0))
    expect(createCalls).to.deep.equal([])
  })
})
