import { strict as assert } from 'assert'
import { mongo } from 'mongoose'
import { AssignmentConflictError, AssignmentSafetyError, assertAssignmentIndex, validateAssignmentSelection, unassignedCandidates, throwAssignmentWriteError, type AssignmentGuard } from '../../src/services/routeAssignment'

const a = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const b = 'bbbbbbbbbbbbbbbbbbbbbbbb'
const c = 'cccccccccccccccccccccccc'
const index = (): unknown => ({ name: 'routeplan_reserved_sale_ids_unique', key: { reservedSaleIds: 1 }, unique: true, sparse: true, v: 2 })

class FakeGuard implements AssignmentGuard {
  indexes: unknown = [{ name: '_id_', key: { _id: 1 } }, index()]
  options: unknown = {}
  snapshots: Array<{ selectedSaleIds: unknown }> = []
  requested: readonly string[] = []
  async readIndexes (): Promise<unknown> { return this.indexes }
  async readCollectionOptions (): Promise<unknown> { return this.options }
  async readAssignedSnapshots (ids: readonly string[]): Promise<Array<{ selectedSaleIds: unknown }>> { this.requested = ids; return this.snapshots }
}

describe('assignment runtime primitives', () => {
  it('accepts only the exact verified reservation index and simple collection options', async () => {
    const guard = new FakeGuard()
    await assertAssignmentIndex(guard)
    for (const bad of [[], undefined, [index(), index()], [{ ...index() as object, unique: false }], [{ ...index() as object, sparse: false }], [{ ...index() as object, collation: { locale: 'en' } }], [{ ...index() as object, key: { reservedSaleIds: 1, other: 1 } }], [index(), { name: 'other', key: { reservedSaleIds: 1 } }]]) {
      guard.indexes = bad
      await assert.rejects(assertAssignmentIndex(guard), AssignmentSafetyError)
    }
    guard.indexes = [index()]
    for (const options of [undefined, null, { collation: { locale: 'simple' } }]) {
      guard.options = options
      await assert.rejects(assertAssignmentIndex(guard), AssignmentSafetyError)
    }
    guard.readIndexes = async () => { throw new Error('unavailable') }
    await assert.rejects(assertAssignmentIndex(guard), AssignmentSafetyError)
  })

  it('requires canonical unique nonempty IDs and exact unique stop coverage', () => {
    validateAssignmentSelection([a, b], [{ saleIds: [b] }, { saleIds: [a] }])
    for (const [ids, stops] of [
      [[], []], [[a, a], [{ saleIds: [a] }]], [[a.toUpperCase()], [{ saleIds: [a] }]],
      [[' bad '], [{ saleIds: [' bad '] }]], [[a], [{ saleIds: [] }]],
      [[a, b], [{ saleIds: [a] }]], [[a], [{ saleIds: [a, a] }]], [[a], [{ saleIds: [a, b] }]]
    ] as Array<[string[], Array<{ saleIds: string[] }> ]>) {
      assert.throws(() => validateAssignmentSelection(ids, stops))
    }
  })

  it('excludes historical and current assigned sales while preserving candidate order and grouping', async () => {
    const guard = new FakeGuard()
    guard.snapshots = [{ selectedSaleIds: [b, c] }, { selectedSaleIds: [b] }]
    const candidates = [{ saleId: a, clientId: 'one' }, { saleId: b, clientId: 'one' }, { saleId: c, clientId: 'two' }, { saleId: a, clientId: 'one' }]
    assert.deepEqual(await unassignedCandidates(guard, candidates), [candidates[0], candidates[3]])
    assert.deepEqual(guard.requested, [a, b, c])
  })

  it('fails closed on malformed snapshot results', async () => {
    const guard = new FakeGuard()
    guard.snapshots = [{ selectedSaleIds: null }]
    await assert.rejects(unassignedCandidates(guard, [{ saleId: a }]), AssignmentSafetyError)
  })

  it('maps only duplicate reservation-key errors and propagates unrelated errors', () => {
    assert.throws(() => throwAssignmentWriteError(new mongo.MongoServerError({ code: 11000, keyPattern: { reservedSaleIds: 1 } })), AssignmentConflictError)
    for (const error of [{ code: 11000, keyPattern: { _id: 1 } }, { code: 11000 }, { code: 42, keyPattern: { reservedSaleIds: 1 } }, { code: 11000, keyPattern: { reservedSaleIds: 1, other: 1 } }]) {
      assert.throws(() => throwAssignmentWriteError(error), (actual) => actual === error)
    }
  })

  it('recognizes only a standard server index token when keyPattern is absent', () => {
    const error = (message: string): mongo.MongoServerError => new mongo.MongoServerError({ message, code: 11000 })
    const prefix = 'E11000 duplicate key error collection: test.routeplans index: '
    assert.throws(() => throwAssignmentWriteError(error(`${prefix}routeplan_reserved_sale_ids_unique dup key: { : "a" }`)), AssignmentConflictError)
    for (const value of [
      error(`${prefix}other dup key: { : "routeplan_reserved_sale_ids_unique" }`),
      error(`${prefix}routeplan_reserved_sale_ids_unique_suffix dup key: { : "a" }`),
      new mongo.MongoServerError({ code: 11000, keyPattern: { other: 1 }, message: `${prefix}routeplan_reserved_sale_ids_unique dup key: { : "a" }` }),
      error('user index: routeplan_reserved_sale_ids_unique dup key: { : "a" }'),
      Object.assign(new Error(`${prefix}routeplan_reserved_sale_ids_unique dup key: { : "a" }`), { code: 11000 })
    ]) assert.throws(() => throwAssignmentWriteError(value), (actual) => actual === value)
  })
})
