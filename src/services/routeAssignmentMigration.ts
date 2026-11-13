import mongoose from 'mongoose'
import RoutePlanModel from '../models/routePlan'
import {
  assignmentCollectionAdapter,
  migrateAssignmentIndex,
  type AssignmentCollection,
  type AssignmentIndexAdapter,
  type MigrationResult
} from '../../migrations/route-plan-005-assignment-index'

export const ROUTE_ASSIGNMENT_INDEX_CONFIRMATION = 'CREATE_ROUTE_ASSIGNMENT_INDEX_ON_LOCAL_TEST'

interface MigrationConnectionTarget {
  readyState: number
  host?: string
  name?: string
}

export interface RouteAssignmentMigrationDependencies {
  getEnvironment: () => string | undefined
  getConnection: () => MigrationConnectionTarget
  createAdapter: () => AssignmentIndexAdapter
  migrate: (adapter: AssignmentIndexAdapter, apply: boolean) => Promise<MigrationResult>
}

export class RouteAssignmentMigrationSafetyError extends Error {
  constructor () {
    super('Route assignment index migration is restricted to a connected local test database')
    this.name = 'RouteAssignmentMigrationSafetyError'
  }
}

const assertLocalTestTarget = (dependencies: RouteAssignmentMigrationDependencies): void => {
  const connection = dependencies.getConnection()
  const isLoopback = connection.host === 'localhost' || connection.host === '127.0.0.1'
  if (dependencies.getEnvironment() === 'production' || connection.readyState !== 1 || !isLoopback || connection.name !== 'test') {
    throw new RouteAssignmentMigrationSafetyError()
  }
}

export const createRouteAssignmentMigrationService = (dependencies: RouteAssignmentMigrationDependencies): {
  preflight: () => Promise<MigrationResult>
  apply: () => Promise<MigrationResult>
} => ({
  preflight: async () => {
    assertLocalTestTarget(dependencies)
    return await dependencies.migrate(dependencies.createAdapter(), false)
  },
  apply: async () => {
    assertLocalTestTarget(dependencies)
    return await dependencies.migrate(dependencies.createAdapter(), true)
  }
})

const createProductionAdapter = (): AssignmentIndexAdapter => {
  const database = mongoose.connection.db
  if (database === undefined) throw new RouteAssignmentMigrationSafetyError()
  const collection = database.collection(RoutePlanModel.collection.name)
  return assignmentCollectionAdapter(collection as unknown as AssignmentCollection)
}

const migrationService = createRouteAssignmentMigrationService({
  getEnvironment: () => process.env.NODE_ENV,
  getConnection: () => ({
    readyState: mongoose.connection.readyState,
    host: mongoose.connection.host,
    name: mongoose.connection.name
  }),
  createAdapter: createProductionAdapter,
  migrate: migrateAssignmentIndex
})

export const preflightAssignmentIndex = migrationService.preflight
export const applyAssignmentIndex = migrationService.apply
