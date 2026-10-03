const { expect } = require('chai')

const {
  MigrationSafetyError,
  collectPreflight,
  parseMigrationArguments,
  runCreateCommercialFactIndexes
} = require('../../migrations/phase-0-helpers')

describe('Phase 0 migration safety', () => {
  it('S-21: rejects a migration without an explicit target URI', () => {
    expect(() => parseMigrationArguments(['--environment', 'local', '--confirm-target', 'local'])).to.throw(MigrationSafetyError)
  })

  it('S-21: rejects a migration without target confirmation', () => {
    expect(() => parseMigrationArguments(['--uri', 'mongodb://127.0.0.1:27017/phase0_migration_test', '--environment', 'local'])).to.throw(MigrationSafetyError)
  })

  it('S-16: dry-run proves index actions without mutating the target', async () => {
    let createIndexCalls = 0
    const db = {
      collection: () => ({
        createIndex: async () => { createIndexCalls += 1 },
        indexes: async () => []
      })
    }

    const result = await runCreateCommercialFactIndexes(db, true)

    expect(result.applied).to.equal(false)
    expect(result.plannedIndexes).to.have.length(3)
    expect(createIndexCalls).to.equal(0)
  })

  it('S-16: applies the expected indexes idempotently to an isolated local database', async function () {
    const { MongoClient } = require('mongodb')
    const uri = 'mongodb://127.0.0.1:27017'
    const databaseName = 'gzapi_phase0_migration_test'
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 1000 })

    try {
      await client.connect()
    } catch (error) {
      this.skip()
      return
    }

    const db = client.db(databaseName)
    await db.dropDatabase()

    try {
      const first = await runCreateCommercialFactIndexes(db, false)
      const second = await runCreateCommercialFactIndexes(db, false)
      const names = (await db.collection('commercialfacts').indexes()).map((index) => index.name).sort()

      expect(first.applied).to.equal(true)
      expect(second.applied).to.equal(true)
      expect(names).to.include.members(['idx_aggregate_type', 'idx_correlation', 'idx_unique_fact_idempotency'])
      expect(names.filter((name) => name === 'idx_unique_fact_idempotency')).to.have.length(1)
    } finally {
      await db.dropDatabase()
      await client.close()
    }
  })

  it('S-21: rejects guarded legacy drift without an explicit classification', async function () {
    const { MongoClient } = require('mongodb')
    const client = new MongoClient('mongodb://127.0.0.1:27017', { serverSelectionTimeoutMS: 1000 })
    try {
      await client.connect()
    } catch (error) {
      this.skip()
      return
    }
    const db = client.db('gzapi_phase0_migration_drift_test')
    await db.dropDatabase()
    await db.collection('products').insertOne({ __v: 1 })
    try {
      let rejected = false
      try {
        await collectPreflight(db)
      } catch (error) {
        rejected = error instanceof MigrationSafetyError
      }
      expect(rejected).to.equal(true)
    } finally {
      await db.dropDatabase()
      await client.close()
    }
  })
})
