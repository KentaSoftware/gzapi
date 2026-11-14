import RoutePlanModel from '../models/routePlan'
import { mongo } from 'mongoose'
import { ASSIGNMENT_INDEX_NAME, AssignmentSafetyError, assertAssignmentIndex, assignmentGuard, type AssignmentGuard } from './routeAssignment'

interface IndexInitializer {
  collectionExists: () => Promise<boolean>
  guard: AssignmentGuard
  createIndex: () => Promise<unknown>
}

const initializer: IndexInitializer = {
  collectionExists: async () => {
    const db = RoutePlanModel.db.db
    if (db === undefined) throw new Error('Database unavailable')
    return (await db.listCollections({ name: RoutePlanModel.collection.name }, { nameOnly: true }).toArray()).length > 0
  },
  guard: assignmentGuard,
  createIndex: async () => await RoutePlanModel.collection.createIndex(
    { reservedSaleIds: 1 },
    { name: ASSIGNMENT_INDEX_NAME, unique: true, sparse: true }
  )
}

function describeFailure (error: unknown): string {
  if (error instanceof mongo.MongoServerError) {
    if (error.code === 13 || error.code === 18) return 'database authorization or authentication failed'
    if (error.code === 11000 || error.code === 11001) return 'duplicate indexed values prevent index creation'
    if (error.code === 85 || error.code === 86) return 'index definition conflicts with an existing index'
    return 'database server rejected the operation'
  }
  if (error instanceof mongo.MongoNetworkError || error instanceof mongo.MongoServerSelectionError) {
    return 'database connection or server selection failed'
  }
  if (error instanceof AssignmentSafetyError) {
    if (error.message === 'Assignment index is incompatible' || error.message === 'Assignment index catalog is incompatible') {
      return 'index definition conflicts with the required index'
    }
    return 'index catalog or collection options failed verification'
  }
  return 'unexpected or unverifiable database failure'
}

// This initializes the catalog only; it cannot certify historical assignments.
export async function initializeAssignmentIndex (deps: IndexInitializer = initializer): Promise<void> {
  let phase = 'reading collection metadata'
  try {
    const exists = await deps.collectionExists()
    const indexes = exists ? await deps.guard.readIndexes() : []
    const options = exists ? await deps.guard.readCollectionOptions() : {}
    if (!Array.isArray(indexes)) throw new AssignmentSafetyError('Assignment index catalog is invalid')
    const named = indexes.some((index: unknown) => typeof index === 'object' && index !== null && 'name' in index && index.name === ASSIGNMENT_INDEX_NAME)
    const candidate = { name: ASSIGNMENT_INDEX_NAME, key: { reservedSaleIds: 1 }, unique: true, sparse: true }
    await assertAssignmentIndex({
      ...deps.guard,
      readIndexes: async () => named ? indexes : [...indexes, candidate],
      readCollectionOptions: async () => options
    })
    if (!named) {
      phase = 'creating index'
      await deps.createIndex()
    }
    phase = 'verifying index'
    const verifiedIndexes = await deps.guard.readIndexes()
    const verifiedOptions = await deps.guard.readCollectionOptions()
    await assertAssignmentIndex({
      ...deps.guard,
      readIndexes: async () => verifiedIndexes,
      readCollectionOptions: async () => verifiedOptions
    })
  } catch (error) {
    throw new Error(`Route assignment index initialization failed while ${phase}: ${describeFailure(error)}`)
  }
}
