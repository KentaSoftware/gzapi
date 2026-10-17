interface MongoCollection {
  createIndex: (keys: Record<string, number>, options: MongoIndexOptions) => void
}

interface MongoDatabase {
  getCollection: (name: string) => MongoCollection
}

interface MongoIndexOptions {
  name: string
  unique?: boolean
  background?: boolean
}

declare const db: MongoDatabase

const routeOptimizationIndexes: ReadonlyArray<readonly [string, Record<string, number>, MongoIndexOptions]> = [
  ['deliveryzones', { code: 1 }, { unique: true, name: 'idx_unique_delivery_zone_code' }],
  ['deliveryzones', { normalizedName: 1 }, { unique: true, name: 'idx_unique_delivery_zone_normalized_name' }],
  ['routingconfigs', { key: 1 }, { unique: true, name: 'idx_unique_routing_config_key' }],
  ['routeplans', { 'zoneSnapshot.code': 1, planningDate: 1 }, { name: 'idx_route_plan_zone_date' }],
  ['routeplans', { 'audit.createdBy': 1, createdAt: -1 }, { name: 'idx_route_plan_creator_date' }],
  ['sales', { 'delivery.status': 1, 'delivery.serviceDate': 1, idCliente: 1 }, { name: 'idx_sale_delivery_status_service_date_client' }]
]

for (const [collection, keys, options] of routeOptimizationIndexes) {
  db.getCollection(collection).createIndex(keys, { ...options, background: true })
  console.log(`Created index ${options.name} on ${collection}`)
}
