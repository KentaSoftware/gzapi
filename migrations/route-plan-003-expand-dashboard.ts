interface MongoCollection {
  createIndex: (keys: Record<string, number>, options: MongoIndexOptions) => void
}

export interface MongoDatabase {
  getCollection: (name: string) => MongoCollection
}

export interface MongoIndexOptions {
  name: string
  unique?: boolean
  background?: boolean
}

declare const db: MongoDatabase

// Expand-only metadata for dashboard reads. Optional snapshot fields are indexed
// without rewriting legacy documents, while operational state remains separate.
export const ROUTE_PLAN_DASHBOARD_INDEXES: ReadonlyArray<readonly [string, Record<string, number>, MongoIndexOptions]> = [
  ['routeplans', { 'saleReferences.saleId': 1 }, { name: 'idx_route_plan_sale_reference' }],
  ['routeplans', { 'fuelAssumptions.availability': 1, planningDate: -1 }, { name: 'idx_route_plan_fuel_availability_date' }],
  ['routeplans', { 'scheduleAssumptions.calculatedAt': -1, planningDate: -1 }, { name: 'idx_route_plan_schedule_calculated_date' }],
  ['routeplanoperationals', { snapshotId: 1 }, { unique: true, name: 'idx_unique_route_plan_operational_snapshot' }],
  ['routeplanoperationals', { status: 1, stale: 1, updatedAt: -1 }, { name: 'idx_route_plan_operational_status_stale_date' }],
  ['routeplanoperationals', { 'assignments.driverId': 1, updatedAt: -1 }, { name: 'idx_route_plan_operational_driver_date' }],
  ['routeplanoperationals', { 'assignments.vehicleId': 1, updatedAt: -1 }, { name: 'idx_route_plan_operational_vehicle_date' }]
]

export const applyRouteDashboardIndexes = (database: MongoDatabase): void => {
  for (const [collection, keys, options] of ROUTE_PLAN_DASHBOARD_INDEXES) {
    database.getCollection(collection).createIndex(keys, { ...options, background: true })
    console.log(`Created index ${options.name} on ${collection}`)
  }
}

if (typeof db !== 'undefined') {
  applyRouteDashboardIndexes(db)
}
