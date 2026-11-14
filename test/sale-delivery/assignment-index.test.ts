import { strict as assert } from 'assert'
import sinon from 'sinon'
import { mongo } from 'mongoose'
import { initializeAssignmentIndex } from '../../src/services/assignmentIndex'
import { ASSIGNMENT_INDEX_NAME, type AssignmentGuard } from '../../src/services/routeAssignment'

const requiredIndex = { name: ASSIGNMENT_INDEX_NAME, key: { reservedSaleIds: 1 }, unique: true, sparse: true }
const idIndex = { name: '_id_', key: { _id: 1 } }

interface TestInitializer {
  guard: AssignmentGuard
  createIndex: sinon.SinonStub
  collectionExists: () => Promise<boolean>
}

describe('assignment index initialization', () => {
  function setup (initial: unknown[] = [idIndex], options: unknown = {}): TestInitializer {
    let indexes = initial
    const guard: AssignmentGuard = {
      readIndexes: async () => indexes,
      readCollectionOptions: async () => options,
      readAssignedSnapshots: async () => []
    }
    const createIndex = sinon.stub().callsFake(async () => { indexes = [...indexes, requiredIndex] })
    return { guard, createIndex, collectionExists: async () => true }
  }

  it('creates and verifies the index idempotently', async () => {
    const deps = setup()
    await initializeAssignmentIndex(deps)
    await initializeAssignmentIndex(deps)
    assert.equal(deps.createIndex.callCount, 1)
  })

  it('accepts the exact existing index without changing it', async () => {
    const deps = setup([idIndex, requiredIndex])
    await initializeAssignmentIndex(deps)
    assert.equal(deps.createIndex.callCount, 0)
  })

  it('rejects conflicting names, keys and collection collation before creation', async () => {
    for (const deps of [
      setup([idIndex, { ...requiredIndex, unique: false }]),
      setup([idIndex, { ...requiredIndex, name: 'equivalent_other_name' }]),
      setup([idIndex, { name: 'wildcard', key: { '$**': 1 } }]),
      setup([idIndex], { collation: { locale: 'en' } })
    ]) {
      await assert.rejects(initializeAssignmentIndex(deps), /initialization failed/)
      assert.equal(deps.createIndex.callCount, 0)
    }
  })

  it('categorizes server and network errors without disclosing sensitive error details', async () => {
    const sensitive = 'mongodb://user:password@private.example/db duplicate secret-value'
    const cases = [
      { error: new mongo.MongoServerError({ code: 11000, message: sensitive }), category: 'duplicate indexed values' },
      { error: new mongo.MongoServerError({ code: 13, message: sensitive }), category: 'authorization or authentication' },
      { error: new mongo.MongoServerError({ code: 18, message: sensitive }), category: 'authorization or authentication' },
      { error: new mongo.MongoServerError({ code: 85, message: sensitive }), category: 'index definition conflicts' },
      { error: new mongo.MongoServerError({ code: 86, message: sensitive }), category: 'index definition conflicts' },
      { error: new mongo.MongoServerError({ code: 123, message: sensitive }), category: 'database server rejected' },
      { error: new mongo.MongoNetworkError(sensitive), category: 'database connection or server selection' },
      { error: Object.setPrototypeOf(new Error(sensitive), mongo.MongoServerSelectionError.prototype), category: 'database connection or server selection' },
      { error: new Error(sensitive), category: 'unexpected or unverifiable' }
    ]
    for (const item of cases) {
      const deps = setup()
      deps.createIndex.rejects(item.error)
      await assert.rejects(initializeAssignmentIndex(deps), (error: Error) => {
        assert.ok(error.message.includes('creating index'))
        assert.ok(error.message.includes(item.category))
        assert.ok(!error.message.includes('password'))
        assert.ok(!error.message.includes('secret-value'))
        assert.ok(!error.message.includes('private.example'))
        return true
      })
    }
  })

  it('reports catalog conflicts and metadata read failures distinctly', async () => {
    const conflicting = setup([idIndex, { ...requiredIndex, unique: false }])
    await assert.rejects(initializeAssignmentIndex(conflicting), /index definition conflicts/)
    const unauthorized = setup()
    unauthorized.guard.readIndexes = async () => { throw new mongo.MongoServerError({ code: 13, message: 'secret-value' }) }
    await assert.rejects(initializeAssignmentIndex(unauthorized), /reading collection metadata: database authorization or authentication failed/)
    const unverifiable = setup([idIndex], { collation: { locale: 'en' } })
    await assert.rejects(initializeAssignmentIndex(unverifiable), /catalog or collection options failed verification/)
  })

  it('preserves safe failure categories when post-creation verification cannot read indexes', async () => {
    const deps = setup()
    let reads = 0
    const original = deps.guard.readIndexes
    deps.guard.readIndexes = async () => {
      if (++reads === 2) throw new mongo.MongoNetworkError('mongodb://private.example/secret')
      return await original()
    }
    await assert.rejects(initializeAssignmentIndex(deps), /verifying index: database connection or server selection failed/)
  })

  it('verifies the resulting catalog after creation', async () => {
    const deps = setup()
    deps.createIndex.resolves()
    await assert.rejects(initializeAssignmentIndex(deps), /initialization failed/)
  })
})
