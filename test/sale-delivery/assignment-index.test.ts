import { strict as assert } from 'assert'
import { assignmentCollectionAdapter, migrateAssignmentIndex, INDEX_NAME, type AssignmentIndexAdapter, type Snapshot, type IndexDescription } from '../../migrations/route-plan-005-assignment-index'

const a = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const b = 'bbbbbbbbbbbbbbbbbbbbbbbb'
const snapshot = (id: string, sale = a): Snapshot => ({ _id: id, selectedSaleIds: [sale], stops: [{ saleIds: [sale] }] })
const validIndex = (): IndexDescription => ({ name: INDEX_NAME, key: { reservedSaleIds: 1 }, unique: true, sparse: true, v: 2 })

class FakeAdapter implements AssignmentIndexAdapter {
  snapshots: Snapshot[] = []
  indexes: IndexDescription[] = [{ name: '_id_', key: { _id: 1 }, v: 2 }]
  options: unknown = {}
  creates = 0
  reads = 0
  failure: Error | undefined

  async * readSnapshots (): AsyncIterable<Snapshot> {
    for (const doc of this.snapshots) { this.reads++; yield doc }
  }

  async readIndexes (): Promise<IndexDescription[]> { return this.indexes }
  async readCollectionOptions (): Promise<unknown> { return this.options }
  async createIndex (): Promise<void> {
    this.creates++
    if (this.failure !== undefined) throw this.failure
    this.indexes.push(validIndex())
  }
}

describe('sparse assignment index preflight', () => {
  it('allows overlapping historical assignments without rewriting and defaults to dry run', async () => {
    const db = new FakeAdapter()
    db.snapshots = [snapshot('1'), snapshot('2')]
    const before = JSON.stringify(db.snapshots)
    const result = await migrateAssignmentIndex(db)
    assert.equal(result.status, 'preview')
    assert.equal(result.audit.snapshots, 2)
    assert.equal(db.creates, 0)
    assert.equal(JSON.stringify(db.snapshots), before)
    assert.equal((await migrateAssignmentIndex(db, true)).status, 'created')
    assert.equal(JSON.stringify(db.snapshots), before)
    assert.equal((await migrateAssignmentIndex(db, true)).status, 'existing')
    assert.equal(db.creates, 1)
  })

  it('blocks missing, null, malformed, empty and noncanonical selected IDs', async () => {
    for (const selectedSaleIds of [undefined, null, 'bad', [], [a.toUpperCase()], [42]]) {
      const db = new FakeAdapter()
      db.snapshots = [snapshot('1'), { _id: '2', selectedSaleIds, stops: [{ saleIds: [a] }] }]
      assert.equal((await migrateAssignmentIndex(db, true)).status, 'blocked')
      assert.equal(db.creates, 0)
    }
  })

  it('blocks duplicated IDs within one selected array', async () => {
    const db = new FakeAdapter()
    db.snapshots = [{ _id: '1', selectedSaleIds: [a, a], stops: [{ saleIds: [a] }] }]
    assert.equal((await migrateAssignmentIndex(db, true)).status, 'blocked')
  })

  it('blocks malformed, duplicate, or mismatching stop references', async () => {
    for (const stops of [undefined, [], [{ saleIds: [b] }], [{ saleIds: [a, a] }], [{ saleIds: ['BAD'] }], [{ saleIds: [a], saleId: b }]]) {
      const db = new FakeAdapter()
      db.snapshots = [{ _id: '1', selectedSaleIds: [a], stops }]
      assert.equal((await migrateAssignmentIndex(db, true)).status, 'blocked')
      assert.equal(db.creates, 0)
    }
  })

  it('accepts historical single-sale stop shape', async () => {
    const db = new FakeAdapter()
    db.snapshots = [{ _id: '1', selectedSaleIds: [a], stops: [{ saleId: a }] }]
    assert.equal((await migrateAssignmentIndex(db)).status, 'preview')
  })

  it('blocks any preexisting reservation for expert investigation', async () => {
    for (const reservedSaleIds of [null, [], [a], [a.toUpperCase()]]) {
      const db = new FakeAdapter()
      db.snapshots = [{ ...snapshot('1'), reservedSaleIds }]
      assert.equal((await migrateAssignmentIndex(db, true)).status, 'blocked')
      assert.equal(db.creates, 0)
    }
  })

  it('streams the complete inventory even after an invalid snapshot', async () => {
    const db = new FakeAdapter()
    db.snapshots = [{ _id: 'bad' }, ...Array.from({ length: 1000 }, (_, i) => snapshot(String(i)))]
    const result = await migrateAssignmentIndex(db, true)
    assert.equal(result.audit.snapshots, 1001)
    assert.equal(db.reads, 1001)
    assert.equal(db.creates, 0)
  })

  it('creates the exact sparse unique index and verifies the catalog', async () => {
    const indexes: IndexDescription[] = [{ name: '_id_', key: { _id: 1 }, v: 2 }]
    let scans = 0
    const adapter = assignmentCollectionAdapter({
      find: (filter, options) => {
        assert.deepEqual(filter, {})
        assert.deepEqual(options, { projection: { _id: 1, selectedSaleIds: 1, reservedSaleIds: 1, stops: 1 } })
        return (async function * () { scans++; yield snapshot('1') })()
      },
      listIndexes: () => ({ toArray: async () => indexes }),
      options: async () => ({}),
      createIndex: async (key, options) => {
        assert.deepEqual(key, { reservedSaleIds: 1 })
        assert.deepEqual(options, { name: INDEX_NAME, unique: true, sparse: true })
        indexes.push(validIndex())
      }
    })
    assert.equal((await migrateAssignmentIndex(adapter, true)).status, 'created')
    assert.equal(scans, 1)
  })

  it('blocks non-simple collection collation or ambiguous and conflicting index catalogs', async () => {
    const cases: IndexDescription[][] = [
      [{ ...validIndex(), sparse: false }],
      [{ ...validIndex(), partialFilterExpression: {} }],
      [{ ...validIndex(), collation: { locale: 'simple' } }],
      [{ name: 'other', key: { reservedSaleIds: 1 }, unique: true, sparse: true }],
      [{ name: 'wild', key: { '$**': 1 } }],
      [{ name: 'unknown', key: null }]
    ]
    for (const indexes of cases) {
      const db = new FakeAdapter()
      db.indexes = indexes
      assert.equal((await migrateAssignmentIndex(db, true)).status, 'blocked')
      assert.equal(db.creates, 0)
    }
    const db = new FakeAdapter()
    db.options = { collation: { locale: 'en' } }
    assert.equal((await migrateAssignmentIndex(db, true)).status, 'blocked')
  })

  it('propagates index creation failure and rejects failed post-verification', async () => {
    const db = new FakeAdapter()
    const failure = new Error('index conflict')
    db.failure = failure
    await assert.rejects(migrateAssignmentIndex(db, true), (error) => error === failure)
    db.failure = undefined
    db.readIndexes = async () => []
    await assert.rejects(migrateAssignmentIndex(db, true), /verification/i)
  })
})
