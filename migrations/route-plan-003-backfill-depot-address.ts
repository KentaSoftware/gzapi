const DEPOT_ADDRESS = 'Depósito de prueba, San Miguel de Tucumán, Tucumán'

interface MongoCollection {
  updateMany: (filter: Record<string, unknown>, update: Record<string, unknown>) => Promise<unknown>
}

export interface DepotAddressBackfillDatabase {
  getCollection: (name: string) => MongoCollection
}

export const runRouteDepotAddressBackfill = async (database: DepotAddressBackfillDatabase): Promise<void> => {
  await database.getCollection('routingconfigs').updateMany(
    { key: 'deposito_1', 'depot.address': { $exists: false } },
    { $set: { 'depot.address': DEPOT_ADDRESS } }
  )
}

declare const db: DepotAddressBackfillDatabase

if (typeof db !== 'undefined') {
  void runRouteDepotAddressBackfill(db)
}
