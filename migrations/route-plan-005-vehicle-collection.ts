interface MongoCollection {
  createIndex: (keys: Record<string, number>, options: MongoIndexOptions) => void
}

export interface VehicleMigrationDatabase {
  getCollection: (name: string) => MongoCollection
}

export interface MongoIndexOptions {
  name: string
  unique?: boolean
  background?: boolean
}

declare const db: VehicleMigrationDatabase

export const VEHICLE_COLLECTION_INDEXES: ReadonlyArray<readonly [string, Record<string, number>, MongoIndexOptions]> = [
  ['vehicles', { code: 1 }, { unique: true, name: 'idx_unique_vehicle_code' }],
  ['vehicles', { active: 1, code: 1 }, { name: 'idx_vehicle_active_code' }]
]

export const applyVehicleCollectionMigration = (database: VehicleMigrationDatabase): void => {
  for (const [collection, keys, options] of VEHICLE_COLLECTION_INDEXES) {
    database.getCollection(collection).createIndex(keys, { ...options, background: true })
    console.log(`Created index ${options.name} on ${collection}`)
  }
}

if (typeof db !== 'undefined') {
  applyVehicleCollectionMigration(db)
}
