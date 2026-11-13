import { expect } from 'chai'
import {
  DEMO_ADDRESS_SPECS,
  inspectDemoFixtures,
  parseDemoArguments,
  resolveTarget,
  runDemoSeed,
  seedDatabase,
  selectRoadSafeCandidate,
  upsertFixture,
  validateRoadConnectivity
} from '../../src/services/seed'
import { GEOCODING_PRECISION } from '../../src/interfaces/client.interface'
import type { DemoDatabase, FixtureCollection } from '../../src/services/seed'
import type { RouteLocation } from '../../src/interfaces/routeOptimization.interface'
import { Types } from 'mongoose'
import { readFileSync } from 'fs'
import { join } from 'path'
import { router as routePlanRouter } from '../../src/routes/routePlan'
import ProductModel from '../../src/models/product'
import ClientModel from '../../src/models/client'
import InventoryMovementModel from '../../src/models/inventoryMovement'
import { calculateAvailability } from '../../src/services/stockRules'
import { STOCK_TIME_ZONE } from '../../src/config/stock'
import { BASELINE_STATUS, EXPIRY_TRACKING } from '../../src/interfaces/stock.interface'

const candidate = {
  formattedAddress: '25 de Mayo 90, San Miguel de Tucumán, Tucumán, Argentina',
  placeId: 'provider-place-id',
  precision: GEOCODING_PRECISION.ROOFTOP,
  lat: -26.8317,
  lng: -65.2032
}

const locations: RouteLocation[] = [
  { id: 'depot', name: 'Depot', latitude: -26.83, longitude: -65.2 },
  { id: 'client-1', name: 'Client', latitude: -26.8317, longitude: -65.2032 }
]

describe('demo seed safety seams', () => {
  it('keeps the build compile-only and exposes no standalone seed or migration scripts', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(packageJson.scripts['vercel-build']).to.equal('npm run build')
    expect(Object.keys(packageJson.scripts).filter((name) => name.startsWith('migration:') || name.startsWith('seed:'))).to.deep.equal([])
    expect(readFileSync(join(process.cwd(), 'src/services/seed.ts'), 'utf8')).not.to.contain('require.main === module')
  })

  it('retains route planning routes without migration endpoints', () => {
    const paths = routePlanRouter.stack.map((layer) => layer.route?.path).filter((path) => path !== undefined)
    expect(paths).to.include('/preview')
    expect(paths).to.include('/dashboard')
    expect(paths).not.to.include('/assignment-index/preflight')
    expect(paths).not.to.include('/assignment-index/apply')
  })
  const target = resolveTarget('mongodb://127.0.0.1:27017/gzapi', false)
  const records = new Map<string, Map<string, Record<string, unknown>>>()
  let writes = 0
  let queue: Promise<void> = Promise.resolve()
  const database: DemoDatabase = {
    collection: (name) => ({
      findOne: async (filter) => name === 'users'
        ? { _id: new Types.ObjectId('507f1f77bcf86cd799439011') }
        : filter.productId !== undefined
          ? [...(records.get(name)?.values() ?? [])].find((record) => String(record.productId) === String(filter.productId)) ?? null
          : records.get(name)?.get(String(filter._id)) ?? null,
      updateOne: async (filter, update) => {
        writes += 1
        const collection = records.get(name) ?? new Map<string, Record<string, unknown>>()
        records.set(name, collection)
        const id = String(filter._id)
        const existing = collection.get(id)
        if (existing !== undefined && update.$set !== undefined && (existing.fixtureNamespace !== filter.fixtureNamespace || existing.fixtureKey !== filter.fixtureKey)) {
          throw new Error('Cannot update an unowned fixture')
        }
        collection.set(id, { ...existing, ...(existing === undefined ? update.$setOnInsert : {}), ...(update.$set ?? {}) })
        return { upsertedCount: existing === undefined ? 1 : 0, modifiedCount: existing === undefined ? 0 : 1 }
      }
    }),
    withTransaction: async (work) => {
      let release: () => void = () => {}
      const previous = queue
      queue = new Promise<void>((resolve) => { release = resolve })
      await previous
      const names = ['products', 'stockexpirybuckets', 'inventorymovements']
      const staged = new Map(names.map((name) => [name, new Map(records.get(name) ?? [])]))
      const transaction: DemoDatabase = {
        collection: (name) => ({
          findOne: async (filter) => filter.productId !== undefined
            ? [...(staged.get(name)?.values() ?? [])].find((record) => String(record.productId) === String(filter.productId)) ?? null
            : staged.get(name)?.get(String(filter._id)) ?? null,
          updateOne: async (filter, update) => {
            const collection = staged.get(name)
            if (collection === undefined) throw new Error('Unexpected transaction collection')
            const id = String(filter._id)
            if (collection.has(id)) return { upsertedCount: 0, modifiedCount: 0 }
            collection.set(id, { ...update.$setOnInsert })
            return { upsertedCount: 1, modifiedCount: 0 }
          }
        })
      }
      try {
        const result = await work(transaction)
        for (const name of names) {
          const target = records.get(name) ?? new Map<string, Record<string, unknown>>()
          for (const [id, record] of staged.get(name) ?? []) if (!target.has(id)) { target.set(id, record); writes += 1 }
          if (target.size > 0) records.set(name, target)
        }
        return result
      } finally { release() }
    }
  }
  const providers = {
    geocoder: async ({ address }: { address: string }) => {
      const index = DEMO_ADDRESS_SPECS.findIndex((spec) => spec.address === address)
      return [{ ...candidate, formattedAddress: address, placeId: `offline-place-${index}`, lat: candidate.lat + index * 0.0001 }]
    },
    matrix: async ({ origins, destinations }: { origins: RouteLocation[], destinations: RouteLocation[] }) => ({
      segments: origins.flatMap((from) => destinations.filter((to) => from.id !== to.id).map((to) => ({
        fromId: from.id, toId: to.id, distanceMeters: 1200, durationSeconds: 120
      })))
    }),
    route: async () => ({ encodedPolyline: 'offline-route', distanceMeters: 5000, durationSeconds: 900 })
  }

  it('seeds only independent fixtures without providers or destructive writes', async () => {
    records.clear()
    const forbidden = ['sales', 'itemsales', 'buys', 'itembuys', 'expenses', 'routeplans']
    const existing = { fixtureKey: 'existing', inventory: { minimum: 42 } }
    records.set('products', new Map([['existing', existing]]))
    const unavailable = {
      geocoder: async () => { throw new Error('Unexpected geocoder') },
      matrix: async () => { throw new Error('Unexpected matrix') },
      route: async () => { throw new Error('Unexpected route') }
    }
    const observed: string[] = []
    const guarded: DemoDatabase = {
      withTransaction: database.withTransaction,
      collection: (name) => {
        observed.push(name)
        if (forbidden.includes(name)) throw new Error(`Unexpected collection ${name}`)
        const collection = database.collection(name)
        return {
          findOne: collection.findOne,
          updateOne: async (filter, update, options) => {
            expect(update.$set).to.equal(undefined)
            expect(options.upsert).to.equal(true)
            return await collection.updateOne(filter, update, options)
          }
        }
      }
    }
    const result = await runDemoSeed({ target, dryRun: false, database: guarded, providers: unavailable, insertOnly: true })
    expect(result.summary?.collections).to.deep.equal({ categories: 7, brands: 9, providers: 6, deliveryzones: 4, products: 15, clients: 12, vehicles: 1, routingconfigs: 1, cashflowconfigs: 1 })
    expect(observed.some((name) => forbidden.includes(name))).to.equal(false)
    expect(records.get('products')?.get('existing')).to.equal(existing)
  })

  it('inserts valid fictional products and clients with supplied coordinates and stable references', async () => {
    records.clear()
    const now = new Date('2026-10-21T00:00:00.000Z')
    await runDemoSeed({ target, dryRun: false, database, now, insertOnly: true })
    const products = [...(records.get('products')?.values() ?? [])]
    const clients = [...(records.get('clients')?.values() ?? [])]
    const zones = [...(records.get('deliveryzones')?.values() ?? [])]
    expect(products).to.have.length(15)
    expect(clients).to.have.length(12)
    for (const product of products) {
      expect(new ProductModel(product).validateSync()).to.equal(undefined)
      expect(product.stock).to.be.within(50, 150)
      expect(product.inventory).to.include({ expiryTracking: 'TRACKED', baselineStatus: 'RECONCILED' })
      expect(product.precioUnitario).to.be.greaterThan(0)
      expect(String(product.descripcion)).not.to.match(/demo|mock|\bgz\b/i)
      for (const [field, collection] of [['categoria', 'categories'], ['marca', 'brands'], ['proveedor', 'providers']]) {
        expect(records.get(collection)?.has(String(product[field]))).to.equal(true)
      }
    }
    for (const client of clients) {
      expect(new ClientModel(client).validateSync()).to.equal(undefined)
      expect(client.isActive).to.equal(true)
      expect(client.geocoding).to.equal(undefined)
      expect(String(client.nombreCompleto)).not.to.match(/demo|mock|\bgz\b/i)
    }
    for (const zone of zones) expect(clients.filter((client) => String(client.deliveryZoneId) === String(zone._id))).to.have.length(3)
    const expected = [
      ['MOLLAR', [[-26.948112, -65.704691], [-26.941400, -65.714023], [-26.936928, -65.702852]]],
      ['TAFI_DEL_VALLE', [[-26.857519, -65.698231], [-26.845241, -65.709813], [-26.848587, -65.689600]]],
      ['SANTA_LUCIA', [[-27.098616, -65.513067], [-27.100511, -65.515926], [-27.105863, -65.517718]]],
      ['SOLDADO_MALDONADO', [[-27.147658, -65.561876], [-27.145107, -65.567734], [-27.142619, -65.567160]]]
    ] as const
    for (const [code, coordinates] of expected) {
      const zone = zones.find((entry) => entry.code === code) as Record<string, unknown>
      const zonedClients = clients.filter((client) => String(client.deliveryZoneId) === String(zone._id))
        .sort((a, b) => Number(String(a.fixtureKey).split(':')[1]) - Number(String(b.fixtureKey).split(':')[1]))
      expect(zonedClients.map(({ lat, lng }) => [lat, lng])).to.deep.equal(coordinates)
    }
    const snapshot = JSON.stringify({ products, clients })
    writes = 0
    await runDemoSeed({ target, dryRun: false, database, now, insertOnly: true })
    expect(writes).to.equal(0)
    expect(JSON.stringify({ products: [...(records.get('products')?.values() ?? [])], clients: [...(records.get('clients')?.values() ?? [])] })).to.equal(snapshot)
    products[0].descripcion = 'Operator edit'
    clients[1].lat = 1
    clients[1].lng = 2
    const config = [...(records.get('routingconfigs')?.values() ?? [])][0]
    const depot = config.depot as Record<string, unknown>
    depot.latitude = 3
    const missing = clients[0]
    records.get('clients')?.delete(String(missing._id))
    await runDemoSeed({ target, dryRun: false, database, now, insertOnly: true })
    expect(products[0].descripcion).to.equal('Operator edit')
    expect(clients[1]).to.include({ lat: 1, lng: 2 })
    expect(depot.latitude).to.equal(3)
    expect(records.get('clients')?.get(String(missing._id))).to.deep.equal(missing)
  })

  it('creates consistent seeded stock with business-day expiry and actual availability rules', async () => {
    records.clear()
    const now = new Date('2026-09-01T02:30:00.000Z')
    await runDemoSeed({ target, dryRun: false, database, now, insertOnly: true })
    const products = [...(records.get('products')?.values() ?? [])]
    const buckets = [...(records.get('stockexpirybuckets')?.values() ?? [])]
    const movements = [...(records.get('inventorymovements')?.values() ?? [])]
    expect(buckets).to.have.length(15)
    expect(movements).to.have.length(15)
    const dates: string[] = []
    for (const product of products) {
      const bucket = buckets.find((entry) => String(entry.productId) === String(product._id)) as Record<string, unknown>
      const movement = movements.find((entry) => String(entry.productId) === String(product._id)) as Record<string, unknown>
      expect(new InventoryMovementModel(movement).validateSync()).to.equal(undefined)
      expect(String(movement.createdBy)).to.equal('507f1f77bcf86cd799439011')
      expect(movement).to.include({ type: 'OPENING', sourceType: 'SYSTEM_SEED', sourceEvent: 'FIXTURE_STOCK_INITIALIZED', quantity: product.stock })
      expect(String(movement.expiryBucketId)).to.equal(String(bucket._id))
      expect(bucket).to.include({ receivedQuantity: product.stock, availableQuantity: product.stock, committedQuantity: 0 })
      const expiryDate = (bucket.expiryDate as Date).toISOString().slice(0, 10)
      dates.push(expiryDate)
      const result = calculateAvailability({ productId: String(product._id), businessDate: '2026-08-31', timeZone: STOCK_TIME_ZONE, physicalQuantity: product.stock as number, committedQuantity: 0, expiryTracking: EXPIRY_TRACKING.TRACKED, baselineStatus: BASELINE_STATUS.RECONCILED, expiryBuckets: [{ bucketId: String(bucket._id), expiryDate, availableQuantity: product.stock as number, committedQuantity: 0 }] })
      expect(result.availableToSell).to.equal(expiryDate < '2026-08-31' ? 0 : product.stock)
    }
    expect(dates.filter((date) => date === '2026-08-30')).to.have.length(3)
    expect(dates.filter((date) => date === '2026-09-20')).to.have.length(3)
    expect(dates.filter((date) => date === '2027-02-28')).to.have.length(9)
    const snapshot = JSON.stringify({ products, buckets, movements })
    await runDemoSeed({ target, dryRun: false, database, now: new Date('2027-01-01T12:00:00Z'), insertOnly: true })
    expect(JSON.stringify({ products, buckets, movements })).to.equal(snapshot)
  })

  it('preserves legacy products and fails on missing seeded evidence', async () => {
    records.clear()
    await runDemoSeed({ target, dryRun: false, database, insertOnly: true })
    const products = [...(records.get('products')?.values() ?? [])]
    const legacy = products[0]
    delete legacy.fixtureStockVersion
    legacy.stock = 0
    delete legacy.inventory
    const bucket = [...(records.get('stockexpirybuckets')?.values() ?? [])].find((entry) => String(entry.productId) === String(legacy._id)) as Record<string, unknown>
    records.get('stockexpirybuckets')?.delete(String(bucket._id))
    await runDemoSeed({ target, dryRun: false, database, insertOnly: true })
    expect(legacy.stock).to.equal(0)
    expect(legacy.inventory).to.equal(undefined)
    const other = products[1]
    const otherBucket = [...(records.get('stockexpirybuckets')?.values() ?? [])].find((entry) => String(entry.productId) === String(other._id)) as Record<string, unknown>
    records.get('stockexpirybuckets')?.delete(String(otherBucket._id))
    try {
      await runDemoSeed({ target, dryRun: false, database, insertOnly: true })
      expect.fail('Expected missing evidence error')
    } catch (error) { expect((error as Error).message).to.contain('inventory evidence') }
  })

  it('rolls back product and bucket when a movement write fails', async () => {
    records.clear()
    const failing: DemoDatabase = {
      collection: database.collection,
      withTransaction: async (work) => await (database.withTransaction as NonNullable<DemoDatabase['withTransaction']>)(async (transaction) => await work({
        collection: (name) => name !== 'inventorymovements'
          ? transaction.collection(name)
          : {
              findOne: transaction.collection(name).findOne,
              updateOne: async () => { throw new Error('Injected movement failure') }
            }
      }))
    }
    try {
      await runDemoSeed({ target, dryRun: false, database: failing, insertOnly: true })
      expect.fail('Expected transaction failure')
    } catch (error) { expect((error as Error).message).to.contain('Injected movement failure') }
    expect(records.get('products')?.size ?? 0).to.equal(0)
    expect(records.get('stockexpirybuckets')?.size ?? 0).to.equal(0)
    expect(records.get('inventorymovements')?.size ?? 0).to.equal(0)
  })

  it('fails closed without transactions and handles concurrent seed attempts', async () => {
    records.clear()
    try {
      await runDemoSeed({ target, dryRun: false, database: { collection: database.collection }, insertOnly: true })
      expect.fail('Expected missing transaction support')
    } catch (error) { expect((error as Error).message).to.contain('requires MongoDB transactions') }
    expect(records.get('products')?.size ?? 0).to.equal(0)
    records.clear()
    await Promise.all([runDemoSeed({ target, dryRun: false, database, insertOnly: true }), runDemoSeed({ target, dryRun: false, database, insertOnly: true })])
    expect(records.get('products')?.size).to.equal(15)
    expect(records.get('stockexpirybuckets')?.size).to.equal(15)
    expect(records.get('inventorymovements')?.size).to.equal(15)
  })

  it('rejects orphaned inventory without recreating its product', async () => {
    records.clear()
    await runDemoSeed({ target, dryRun: false, database, insertOnly: true })
    const product = [...(records.get('products')?.values() ?? [])][0]
    records.get('products')?.delete(String(product._id))
    try {
      await runDemoSeed({ target, dryRun: false, database, insertOnly: true })
      expect.fail('Expected orphaned inventory error')
    } catch (error) { expect((error as Error).message).to.contain('Existing inventory evidence') }
    expect(records.get('products')?.has(String(product._id))).to.equal(false)
  })

  it('propagates an unsupported transaction error without inserting inventory', async () => {
    records.clear()
    const unsupported: DemoDatabase = {
      collection: database.collection,
      withTransaction: async () => { throw new Error('Transactions unsupported') }
    }
    try {
      await runDemoSeed({ target, dryRun: false, database: unsupported, insertOnly: true })
      expect.fail('Expected unsupported transaction error')
    } catch (error) { expect((error as Error).message).to.equal('Transactions unsupported') }
    expect(records.get('products')?.size ?? 0).to.equal(0)
    expect(records.get('stockexpirybuckets')?.size ?? 0).to.equal(0)
    expect(records.get('inventorymovements')?.size ?? 0).to.equal(0)
  })

  it('uses neutral visible values while retaining fixture identities', async () => {
    records.clear()
    await runDemoSeed({ target, dryRun: false, database, insertOnly: true })
    const descriptions = (collection: string): unknown[] => [...(records.get(collection)?.values() ?? [])].map((record) => record.descripcion)
    expect(descriptions('categories')).to.deep.equal(['Catálogo', 'Bebidas', 'Almacén', 'Limpieza', 'Cuidado personal', 'Aperitivos', 'Despensa'])
    expect(descriptions('brands')).to.deep.equal(['Marca', 'Andes', 'Norte', 'Pampa', 'Sol', 'Río', 'Valle', 'Campo', 'Luna'])
    expect(descriptions('providers')).to.deep.equal(['Proveedor', 'Distribuidora Norte', 'Abastecimiento Regional', 'Mayorista del Valle', 'Comercializadora del Río', 'Mercadería Central'])
    const zones = [...(records.get('deliveryzones')?.values() ?? [])]
    expect(zones.map(({ fixtureKey, code, name, normalizedName }) => ({ fixtureKey, code, name, normalizedName }))).to.deep.equal([
      { fixtureKey: 'zone:centro', code: 'MOLLAR', name: 'Mollar', normalizedName: 'mollar' },
      { fixtureKey: 'zone:oeste', code: 'TAFI_DEL_VALLE', name: 'Tafí del Valle', normalizedName: 'tafí del valle' },
      { fixtureKey: 'zone:sur', code: 'SANTA_LUCIA', name: 'Santa Lucía', normalizedName: 'santa lucía' },
      { fixtureKey: 'zone:soldado-maldonado', code: 'SOLDADO_MALDONADO', name: 'Soldado Maldonado', normalizedName: 'soldado maldonado' }
    ])
    const vehicle = [...(records.get('vehicles')?.values() ?? [])][0]
    expect(vehicle).to.include({ fixtureKey: 'vehicle:primary', code: '01', fuelConsumptionLitersPer100Km: 8.5, active: true })
    expect(vehicle.attributes).to.deep.equal({ fixture: 'gzapi-demo-seed-v1' })
    const depot = [...(records.get('routingconfigs')?.values() ?? [])][0].depot as { name: string }
    expect(depot.name).to.equal('Depósito')
  })

  it('rejects unique code collisions without overwriting unrelated records', async () => {
    for (const [collectionName, code] of [['deliveryzones', 'MOLLAR'], ['deliveryzones', 'SOLDADO_MALDONADO'], ['vehicles', '01']]) {
      records.clear()
      const existing = { _id: new Types.ObjectId(), code, owner: 'unrelated' }
      records.set(collectionName, new Map([[String(existing._id), existing]]))
      const guarded: DemoDatabase = {
        withTransaction: database.withTransaction,
        collection: (name) => ({
          findOne: database.collection(name).findOne,
          updateOne: async (filter, update, options) => {
            if (name === collectionName && update.$setOnInsert.code === code) {
              throw Object.assign(new Error('Duplicate code'), { code: 11000 })
            }
            return await database.collection(name).updateOne(filter, update, options)
          }
        })
      }
      try {
        await runDemoSeed({ target, dryRun: false, database: guarded, insertOnly: true })
        expect.fail('Expected unique code collision')
      } catch (error) {
        expect((error as Error).message).to.contain('identity conflict')
      }
      expect(records.get(collectionName)?.get(String(existing._id))).to.equal(existing)
      expect(existing).to.include({ code, owner: 'unrelated' })
    }
  })

  it('uses the supplied depot coordinates without asserting an address or validation', async () => {
    records.clear()
    await runDemoSeed({ target, dryRun: false, database, insertOnly: true })
    const config = [...(records.get('routingconfigs')?.values() ?? [])][0]
    const depot = config.depot as Record<string, unknown>
    expect(depot).to.include({ latitude: -27.347969, longitude: -65.586886 })
    expect(depot.address).to.equal(undefined)
    expect(depot.geocoding).to.equal(undefined)
  })

  it('retains existing zone values while inserting only the new fourth fixture', async () => {
    records.clear()
    await runDemoSeed({ target, dryRun: false, database, insertOnly: true })
    const zones = records.get('deliveryzones') as Map<string, Record<string, unknown>>
    const legacy = [...zones.values()].find((zone) => zone.fixtureKey === 'zone:centro') as Record<string, unknown>
    legacy.name = 'Centro'
    legacy.code = 'CENTRO'
    legacy.normalizedName = 'centro'
    const fourth = [...zones.entries()].find(([, zone]) => zone.fixtureKey === 'zone:soldado-maldonado') as [string, Record<string, unknown>]
    zones.delete(fourth[0])
    const result = await runDemoSeed({ target, dryRun: false, database, insertOnly: true })
    expect(result.summary?.inserted).to.equal(1)
    expect(legacy).to.include({ name: 'Centro', code: 'CENTRO', normalizedName: 'centro' })
    expect(zones.get(fourth[0])?.name).to.equal('Soldado Maldonado')
  })

  it('repairs only missing independent fixtures and preserves edited and excluded records', async () => {
    records.clear()
    const date = new Date('2026-10-21T00:00:00.000Z')
    await runDemoSeed({ target, dryRun: false, database, serviceDate: date, insertOnly: true })
    const categories = records.get('categories') as Map<string, Record<string, unknown>>
    const retained = [...categories.values()].find((record) => record.fixtureKey === 'catalog:category') as Record<string, unknown>
    retained.descripcion = 'Operator edit'
    const missing = [...categories.entries()].find(([, record]) => record.fixtureKey === 'catalog:category:1') as [string, Record<string, unknown>]
    categories.delete(missing[0])
    const oldSale = { fixtureKey: 'old-sale', total: 42 }
    records.set('sales', new Map([['old-sale', oldSale]]))
    writes = 0
    const repaired = await runDemoSeed({ target, dryRun: false, database, serviceDate: date, insertOnly: true })
    expect(repaired.summary?.inserted).to.equal(1)
    expect(writes).to.equal(1)
    expect(retained.descripcion).to.equal('Operator edit')
    expect(records.get('sales')?.get('old-sale')).to.equal(oldSale)
    expect((await inspectDemoFixtures(database, date)).missing).to.equal(0)
  })

  it('rejects an independent fixture identity collision before any write', async () => {
    records.clear()
    const date = new Date('2026-10-21T00:00:00.000Z')
    await runDemoSeed({ target, dryRun: false, database, serviceDate: date, insertOnly: true })
    const category = [...(records.get('categories')?.values() ?? [])][0]
    category.fixtureNamespace = 'another-owner'
    writes = 0
    try {
      await runDemoSeed({ target, dryRun: false, database, serviceDate: date, insertOnly: true })
      expect.fail('Expected identity conflict')
    } catch (error) {
      expect((error as Error).message).to.contain('identity conflict')
    }
    expect(writes).to.equal(0)
  })

  it('rejects product and client identity collisions before any write', async () => {
    for (const collection of ['products', 'clients']) {
      records.clear()
      await runDemoSeed({ target, dryRun: false, database, insertOnly: true })
      const record = [...(records.get(collection)?.values() ?? [])][0]
      record.fixtureNamespace = 'another-owner'
      writes = 0
      try {
        await runDemoSeed({ target, dryRun: false, database, insertOnly: true })
        expect.fail('Expected identity conflict')
      } catch (error) {
        expect((error as Error).message).to.contain('identity conflict')
      }
      expect(writes).to.equal(0)
      expect(record.fixtureNamespace).to.equal('another-owner')
    }
  })

  it('delegates fixture seeding after base seeding through injectable dependencies', async () => {
    const calls: string[] = []
    await seedDatabase({
      seedBase: async () => { calls.push('base') },
      seedDemoFixtures: async () => { calls.push('fixtures') }
    })
    expect(calls).to.deep.equal(['base', 'fixtures'])
  })

  it('bounds concurrent inventory reads while checking every owned fixture', async () => {
    let active = 0
    let peak = 0
    let reads = 0
    const slow: DemoDatabase = {
      withTransaction: database.withTransaction,
      collection: () => ({
        findOne: async () => {
          active += 1
          peak = Math.max(peak, active)
          await new Promise<void>((resolve) => setImmediate(resolve))
          active -= 1
          reads += 1
          return null
        },
        updateOne: async () => { throw new Error('Unexpected write') }
      })
    }
    const inventory = await inspectDemoFixtures(slow, new Date('2026-10-21T00:00:00.000Z'))
    expect(reads).to.equal(inventory.total)
    expect(inventory.missing).to.equal(inventory.total)
    expect(peak).to.be.greaterThan(1)
    expect(peak).to.be.at.most(16)
  })

  it('bounds concurrent fixture writes during an insert-only repair', async () => {
    records.clear()
    const date = new Date('2026-10-21T00:00:00.000Z')
    let active = 0
    let peak = 0
    const slow: DemoDatabase = {
      withTransaction: database.withTransaction,
      collection: (name) => ({
        findOne: database.collection(name).findOne,
        updateOne: async (filter, update, options) => {
          active += 1
          peak = Math.max(peak, active)
          await new Promise<void>((resolve) => setImmediate(resolve))
          try {
            return await database.collection(name).updateOne(filter, update, options)
          } finally {
            active -= 1
          }
        }
      })
    }
    const result = await runDemoSeed({ target, dryRun: false, database: slow, providers, serviceDate: date, insertOnly: true })
    expect(result.summary?.inserted).to.equal(56)
    expect(peak).to.be.greaterThan(1)
    expect(peak).to.be.at.most(8)
  })

  it('plans only the depot without calling providers in dry-run', async () => {
    expect(DEMO_ADDRESS_SPECS).to.have.length(1)
    const result = await runDemoSeed({ target, dryRun: true })
    expect(result.addressCount).to.equal(1)
  })

  it('skips a complete owned dataset without a provider call or write', async () => {
    records.clear()
    const date = new Date('2026-10-21T00:00:00.000Z')
    await runDemoSeed({ target, dryRun: false, database, providers, serviceDate: date })
    const inventory = await inspectDemoFixtures(database, date)
    expect(inventory.missing).to.equal(0)
    writes = 0
    const result = await runDemoSeed({
      target,
      dryRun: false,
      database,
      serviceDate: date,
      insertOnly: true,
      providers: { ...providers, geocoder: async () => { throw new Error('Provider should not be called') } }
    })
    expect(result.summary?.inserted).to.equal(0)
    expect(writes).to.equal(0)
  })

  it('rejects a matrix above the configured stop limit without calling the provider', async () => {
    let calls = 0
    try {
      await validateRoadConnectivity(locations[0], Array.from({ length: 21 }, (_, index) => ({ ...locations[1], id: `client-${index}` })), async () => {
        calls += 1
        return { segments: [] }
      })
      expect.fail('Expected stop limit failure')
    } catch (error) {
      expect((error as Error).message).to.contain('stop limit')
    }
    expect(calls).to.equal(0)
  })
  it('rejects a remote target without explicit confirmation', () => {
    expect(() => resolveTarget('mongodb+srv://cluster.example/gzapi', false)).to.throw('explicit --confirm-remote')
    expect(resolveTarget('mongodb://127.0.0.1:27017/gzapi', false).remote).to.equal(false)
  })

  it('dry-run argument parsing does not require or expose a target credential', () => {
    const result = parseDemoArguments(['--dry-run'], { MONGODB_URI: 'mongodb://127.0.0.1:27017/gzapi' })
    expect(result.dryRun).to.equal(true)
    expect(result.target.database).to.equal('gzapi')
  })

  it('dry-run execution performs no database access or writes', async () => {
    let collectionCalls = 0
    const result = await runDemoSeed({
      target: resolveTarget('mongodb://127.0.0.1:27017/gzapi', false),
      dryRun: true,
      database: {
        collection: (): FixtureCollection => {
          collectionCalls += 1
          return {
            findOne: async () => null,
            updateOne: async () => ({ upsertedCount: 0, modifiedCount: 0 })
          }
        }
      }
    })
    expect(result.dryRun).to.equal(true)
    expect(collectionCalls).to.equal(0)
  })

  it('rejects approximate geocoding results', () => {
    expect(() => selectRoadSafeCandidate([{ ...candidate, precision: GEOCODING_PRECISION.APPROXIMATE }], 'demo address')).to.throw('road-safe precision')
    expect(() => selectRoadSafeCandidate([], 'demo address')).to.throw('empty or ambiguous')
  })

  it('rejects an unroutable client before persistence', async () => {
    const matrix = async (): Promise<{ segments: [] }> => ({ segments: [] })
    try {
      await validateRoadConnectivity(locations[0], [locations[1]], matrix)
      expect.fail('Expected missing reverse route to fail')
    } catch (error) {
      expect(error).to.be.instanceOf(Error)
      expect((error as Error).message).to.contain('DRIVE route')
    }
  })

  it('uses the same deterministic fixture key for repeat upserts', async () => {
    const calls: Array<{ filter: Record<string, unknown>, id: unknown }> = []
    const collection: FixtureCollection = {
      findOne: async () => null,
      updateOne: async (filter) => {
        calls.push({ filter, id: filter._id })
        return { upsertedCount: calls.length === 1 ? 1 : 0, modifiedCount: calls.length === 1 ? 0 : 1 }
      }
    }
    const id = new Types.ObjectId('507f1f77bcf86cd799439011')
    expect(await upsertFixture(collection, 'client:centro:1', id, { name: 'demo' }, new Date('2026-10-01T00:00:00.000Z'))).to.equal('inserted')
    expect(await upsertFixture(collection, 'client:centro:1', id, { name: 'demo' }, new Date('2026-10-01T00:00:00.000Z'))).to.equal('updated')
    expect(calls).to.have.length(2)
    expect(calls[0].id).to.equal(calls[1].id)
    expect(calls[0].filter.fixtureNamespace).to.equal('gzapi-demo-seed-v1')
  })

  it('requires the requested street and number despite precise matching-city results', () => {
    const requested = 'Av. Córdoba 560, San Miguel de Tucumán, Tucumán, Argentina'
    const accepted = { ...candidate, formattedAddress: 'Avenida Cordoba 560, San Miguel de Tucuman, Tucuman, Argentina' }
    expect(selectRoadSafeCandidate([accepted], requested)).to.equal(accepted)
    for (const formattedAddress of [
      'Avenida Cordoba 561, San Miguel de Tucuman, Tucuman, Argentina',
      'Avenida Belgrano 560, San Miguel de Tucuman, Tucuman, Argentina',
      'Avenida Cordoba, San Miguel de Tucuman, Tucuman, Argentina',
      'Córdoba 560, Córdoba, Argentina'
    ]) {
      expect(() => selectRoadSafeCandidate([{ ...candidate, formattedAddress }], requested)).to.throw()
    }
    expect(selectRoadSafeCandidate([{ ...candidate, formattedAddress: 'General Paz 523, San Miguel de Tucumán, Tucumán, Argentina' }], 'Gral. Paz 523, San Miguel de Tucumán, Tucumán, Argentina').precision).to.equal(GEOCODING_PRECISION.ROOFTOP)
  })

  it('does not match unowned records by id during an upsert', async () => {
    const id = new Types.ObjectId('507f1f77bcf86cd799439012')
    const collection: FixtureCollection = {
      findOne: async () => null,
      updateOne: async (filter) => {
        expect(filter).to.deep.include({ _id: id, fixtureNamespace: 'gzapi-demo-seed-v1', fixtureKey: 'catalog:product' })
        throw new Error('Duplicate identifier belongs to an unowned record')
      }
    }
    try {
      await upsertFixture(collection, 'catalog:product', id, { descripcion: 'Demo' }, new Date())
      expect.fail('Expected ownership conflict')
    } catch (error) {
      expect((error as Error).message).to.contain('unowned')
    }
  })
})
