import { expect } from 'chai'
import {
  DEMO_ADDRESS_SPECS,
  inspectDemoFixtures,
  parseDemoArguments,
  resolveTarget,
  runDemoSeed,
  selectRoadSafeCandidate,
  upsertFixture,
  validateRoadConnectivity
} from '../../migrations/demo-001-seed-data'
import { GEOCODING_PRECISION } from '../../src/interfaces/client.interface'
import type { DemoDatabase, FixtureCollection } from '../../migrations/demo-001-seed-data'
import type { RouteLocation } from '../../src/interfaces/routeOptimization.interface'
import { Types } from 'mongoose'

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
  const target = resolveTarget('mongodb://127.0.0.1:27017/gzapi', false)
  const records = new Map<string, Map<string, Record<string, unknown>>>()
  let writes = 0
  const database: DemoDatabase = {
    collection: (name) => ({
      findOne: async (filter) => name === 'users'
        ? { _id: new Types.ObjectId('507f1f77bcf86cd799439011') }
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
    })
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

  it('bounds concurrent inventory reads while checking every owned fixture', async () => {
    let active = 0
    let peak = 0
    let reads = 0
    const slow: DemoDatabase = {
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

  it('avoids repeat reads and writes for inventoried owned fixtures during a repair', async () => {
    records.clear()
    const date = new Date('2026-10-21T00:00:00.000Z')
    let reads = 0
    let updates = 0
    const counted: DemoDatabase = {
      collection: (name) => {
        const base = database.collection(name)
        return {
          findOne: async (filter) => { reads += 1; return await base.findOne(filter) },
          updateOne: async (filter, update, options) => { updates += 1; return await base.updateOne(filter, update, options) }
        }
      }
    }
    const first = await runDemoSeed({ target, dryRun: false, database: counted, providers, serviceDate: date, insertOnly: true })
    const total = (first.summary?.inserted ?? 0) + (first.summary?.updated ?? 0)
    expect(reads).to.equal((await inspectDemoFixtures(database, date)).total + 1)
    expect(updates).to.equal(total)
    reads = 0
    updates = 0
    records.get('products')?.delete(String([...records.get('products')?.entries() ?? []].find(([, value]) => value.fixtureKey === 'catalog:product:1:1')?.[0]))
    const repaired = await runDemoSeed({ target, dryRun: false, database: counted, providers, serviceDate: date, insertOnly: true })
    expect(repaired.summary?.inserted).to.equal(1)
    expect(updates).to.equal(2)
    expect(reads).to.equal((await inspectDemoFixtures(database, date)).total + 1)
  })

  it('bounds concurrent fixture writes during an insert-only repair', async () => {
    records.clear()
    const date = new Date('2026-10-21T00:00:00.000Z')
    let active = 0
    let peak = 0
    const slow: DemoDatabase = {
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
    expect(result.summary?.inserted ?? 0).to.be.greaterThan(100)
    expect(peak).to.be.greaterThan(1)
    expect(peak).to.be.at.most(8)
  })

  it('rejects an unowned concurrent insert after inventory without overwriting it', async () => {
    records.clear()
    const date = new Date('2026-10-21T00:00:00.000Z')
    await runDemoSeed({ target, dryRun: false, database, providers, serviceDate: date, insertOnly: true })
    const products = records.get('products') as Map<string, Record<string, unknown>>
    const [id] = [...products.entries()].find(([, value]) => value.fixtureKey === 'catalog:product:1:1') as [string, Record<string, unknown>]
    products.delete(id)
    const unowned = { fixtureNamespace: 'other-owner', fixtureKey: 'other-product', stock: 99 }
    const racing: DemoDatabase = {
      collection: (name) => {
        const base = database.collection(name)
        return {
          findOne: base.findOne,
          updateOne: async (filter, update, options) => {
            if (name === 'products' && String(filter._id) === id) {
              products.set(id, unowned)
              return { upsertedCount: 0, modifiedCount: 0 }
            }
            return await base.updateOne(filter, update, options)
          }
        }
      }
    }
    try {
      await runDemoSeed({ target, dryRun: false, database: racing, providers, serviceDate: date, insertOnly: true })
      expect.fail('Expected concurrent ownership conflict')
    } catch (error) {
      expect((error as Error).message).to.contain('identity conflict')
    }
    expect(products.get(id)).to.equal(unowned)
  })

  it('plans 20 candidate clients without calling providers in dry-run', async () => {
    expect(DEMO_ADDRESS_SPECS).to.have.length(21)
    const result = await runDemoSeed({ target, dryRun: true })
    expect(result.addressCount).to.equal(21)
  })

  it('seeds six months of paid finance, catalog and route snapshots with stable owned IDs', async () => {
    records.clear()
    writes = 0
    const first = await runDemoSeed({ target, dryRun: false, database, providers, serviceDate: new Date('2026-10-21T00:00:00.000Z') })
    expect((first.summary?.inserted ?? 0) + (first.summary?.updated ?? 0)).to.equal(writes)
    expect(records.get('clients')?.size).to.equal(20)
    expect(records.get('categories')?.size).to.equal(7)
    expect(records.get('brands')?.size).to.equal(9)
    expect(records.get('providers')?.size).to.equal(6)
    expect(records.get('products')?.size).to.equal(85)
    expect(records.get('routeplans')?.size).to.equal(3)
    const sales = [...(records.get('sales')?.values() ?? [])]
    const buys = [...(records.get('buys')?.values() ?? [])]
    const expenses = [...(records.get('expenses')?.values() ?? [])]
    for (const month of ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']) {
      expect(sales.filter((sale) => sale.paidAt instanceof Date && sale.paidAt.toISOString().startsWith(month))).to.have.length(21)
      expect(buys.filter((buy) => buy.paidAt instanceof Date && buy.paidAt.toISOString().startsWith(month))).to.have.length(7)
      expect(expenses.filter((expense) => expense.date instanceof Date && expense.date.toISOString().startsWith(month))).to.have.length(11)
    }
    const clientIds = new Set(records.get('clients')?.keys())
    for (const snapshot of records.get('routeplans')?.values() ?? []) {
      for (const stop of snapshot.stops as Array<{ clientId: string }>) {
        expect(Types.ObjectId.isValid(stop.clientId)).to.equal(true)
        expect(clientIds.has(stop.clientId)).to.equal(true)
      }
    }
    const counts = [...records].map(([key, value]) => [key, value.size])
    const firstSale = sales.find((sale) => sale.fixtureKey === 'finance:sale:2026-05:1')
    expect(firstSale?.createdAt).to.deep.equal(new Date('2026-05-01T12:00:00.000Z'))
    const second = await runDemoSeed({ target, dryRun: false, database, providers, serviceDate: new Date('2026-10-21T00:00:00.000Z') })
    expect(second.summary?.inserted).to.equal(0)
    expect([...records].map(([key, value]) => [key, value.size])).to.deep.equal(counts)
    expect([...(records.get('sales')?.values() ?? [])].find((sale) => sale.fixtureKey === 'finance:sale:2026-05:1')?.createdAt).to.deep.equal(firstSale?.createdAt)
  })

  it('seeds owned Smart Stock minimums, reconciled baselines, expiry buckets, and opening movements', async () => {
    records.clear()
    await runDemoSeed({ target, dryRun: false, database, providers, serviceDate: new Date('2026-10-21T00:00:00.000Z') })
    const products = [...(records.get('products')?.values() ?? [])].filter((item) => String(item.fixtureKey).startsWith('catalog:product:'))
    expect(products).to.have.length(84)
    expect(products.every((product) => {
      const inventory = product.inventory as Record<string, unknown> | undefined
      return inventory?.minimum !== undefined && inventory.expiryTracking === 'tracked' && inventory.baselineStatus === 'reconciled'
    })).to.equal(true)
    const buckets = [...(records.get('stockexpirybuckets')?.values() ?? [])]
    const movements = [...(records.get('inventorymovements')?.values() ?? [])]
    expect(buckets).to.have.length.greaterThan(84)
    expect(movements).to.have.length(buckets.length)
    expect(buckets.some((bucket) => new Date(bucket.expiryDate as Date).getTime() < Date.parse('2026-10-21'))).to.equal(true)
    expect(buckets.some((bucket) => new Date(bucket.expiryDate as Date).getTime() > Date.parse('2026-10-21'))).to.equal(true)
    expect(movements.every((movement) => movement.type === 'OPENING')).to.equal(true)
    for (const product of products) {
      const productBuckets = buckets.filter((bucket) => String(bucket.productId) === String(product._id))
      expect(productBuckets.reduce((sum, bucket) => sum + Number(bucket.receivedQuantity), 0)).to.equal(product.stock)
      expect(productBuckets.reduce((sum, bucket) => sum + Number(bucket.availableQuantity), 0)).to.equal(product.stock)
      expect(productBuckets.reduce((sum, bucket) => sum + Number(bucket.committedQuantity), 0)).to.equal(0)
    }
    expect(products.some((product) => ((product.inventory as Record<string, unknown>).minimum as number) > (product.stock as number))).to.equal(true)
  })

  it('repairs missing stock fixtures independently without touching an unrelated bucket', async () => {
    records.clear()
    const date = new Date('2026-10-21T00:00:00.000Z')
    await runDemoSeed({ target, dryRun: false, database, providers, serviceDate: date })
    const buckets = records.get('stockexpirybuckets') as Map<string, Record<string, unknown>>
    const first = buckets.entries().next().value as [string, Record<string, unknown>]
    const before = await inspectDemoFixtures(database, date)
    buckets.delete(first[0])
    expect((await inspectDemoFixtures(database, date)).missing).to.equal(before.missing + 1)
    const result = await runDemoSeed({ target, dryRun: false, database, providers, serviceDate: date, insertOnly: true })
    expect(result.summary?.inserted).to.be.greaterThan(0)
    expect([...buckets.values()].some((bucket) => bucket.fixtureKey === first[1].fixtureKey)).to.equal(true)
  })

  it('repairs stock fixtures when all catalog fixture documents are already complete', async () => {
    records.clear()
    const date = new Date('2026-10-21T00:00:00.000Z')
    await runDemoSeed({ target, dryRun: false, database, providers, serviceDate: date })
    const buckets = records.get('stockexpirybuckets') as Map<string, Record<string, unknown>>
    const product = records.get('products') as Map<string, Record<string, unknown>>
    buckets.clear()
    records.delete('inventorymovements')
    for (const item of product.values()) {
      if (String(item.fixtureKey).startsWith('catalog:product')) delete item.inventory
    }
    expect((await inspectDemoFixtures(database, date)).missing).to.be.greaterThan(0)
    const repaired = await runDemoSeed({ target, dryRun: false, database, providers, serviceDate: date, insertOnly: true })
    expect(repaired.summary?.inserted).to.be.greaterThan(0)
    expect(buckets.size).to.be.greaterThan(84)
    expect(records.get('inventorymovements')?.size).to.equal(buckets.size)
    expect((await inspectDemoFixtures(database, date)).missing).to.equal(0)
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

  it('repairs only a missing fixture while retaining edited owned data', async () => {
    records.clear()
    const date = new Date('2026-10-21T00:00:00.000Z')
    await runDemoSeed({ target, dryRun: false, database, providers, serviceDate: date })
    const products = records.get('products') as Map<string, Record<string, unknown>>
    const first = [...products.values()].find((item) => item.fixtureKey === 'catalog:product') as Record<string, unknown>
    first.stock = 13
    const missing = [...products.entries()].find(([, item]) => item.fixtureKey === 'catalog:product:1:1') as [string, Record<string, unknown>]
    products.delete(missing[0])
    expect((await inspectDemoFixtures(database, date)).missing).to.equal(2)
    writes = 0
    const result = await runDemoSeed({ target, dryRun: false, database, providers, serviceDate: date, insertOnly: true })
    expect(result.summary?.inserted).to.be.greaterThan(0)
    expect(products.get(missing[0])?.fixtureKey).to.equal('catalog:product:1:1')
    expect(first.stock).to.equal(13)
    expect((await inspectDemoFixtures(database, date)).missing).to.equal(0)
  })

  it('rejects an identity collision before contacting Google or writing', async () => {
    records.clear()
    const date = new Date('2026-10-21T00:00:00.000Z')
    await runDemoSeed({ target, dryRun: false, database, providers, serviceDate: date })
    const products = records.get('products') as Map<string, Record<string, unknown>>
    const item = [...products.values()].find((value) => value.fixtureKey === 'catalog:product') as Record<string, unknown>
    item.fixtureNamespace = 'someone-else'
    writes = 0
    try {
      await runDemoSeed({
        target,
        dryRun: false,
        database,
        serviceDate: date,
        insertOnly: true,
        providers: { ...providers, geocoder: async () => { throw new Error('Provider should not be called') } }
      })
      expect.fail('Expected identity conflict')
    } catch (error) {
      expect((error as Error).message).to.contain('identity conflict')
    }
    expect(writes).to.equal(0)
  })

  it('does not write a partial repair when provider preflight fails', async () => {
    records.clear()
    const date = new Date('2026-10-21T00:00:00.000Z')
    await runDemoSeed({ target, dryRun: false, database, providers, serviceDate: date })
    const products = records.get('products') as Map<string, Record<string, unknown>>
    const missing = [...products.entries()].find(([, value]) => value.fixtureKey === 'catalog:product:1:1') as [string, Record<string, unknown>]
    products.delete(missing[0])
    writes = 0
    try {
      await runDemoSeed({
        target,
        dryRun: false,
        database,
        serviceDate: date,
        insertOnly: true,
        providers: { ...providers, matrix: async () => ({ segments: [] }) }
      })
      expect.fail('Expected provider failure')
    } catch (error) {
      expect((error as Error).message).to.contain('DRIVE route')
    }
    expect(writes).to.equal(0)
    expect(products.has(missing[0])).to.equal(false)
  })

  it('allows two concurrent repairs without overwriting a winning insert', async () => {
    records.clear()
    const date = new Date('2026-10-21T00:00:00.000Z')
    await runDemoSeed({ target, dryRun: false, database, providers, serviceDate: date })
    const products = records.get('products') as Map<string, Record<string, unknown>>
    const missing = [...products.entries()].find(([, value]) => value.fixtureKey === 'catalog:product:1:1') as [string, Record<string, unknown>]
    products.delete(missing[0])
    const results = await Promise.all([1, 2].map(async () => await runDemoSeed({
      target, dryRun: false, database, providers, serviceDate: date, insertOnly: true
    })))
    expect(results.reduce((sum, result) => sum + (result.summary?.inserted ?? 0), 0)).to.equal(1)
    expect((await inspectDemoFixtures(database, date)).missing).to.equal(0)
  })

  it('performs zero writes when matrix or route validation fails', async () => {
    for (const unavailable of [
      { ...providers, matrix: async () => ({ segments: [] }) },
      { ...providers, route: async () => { throw new Error('Provider unavailable') } }
    ]) {
      writes = 0
      try {
        await runDemoSeed({ target, dryRun: false, database, providers: unavailable })
        expect.fail('Expected provider failure')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
      }
      expect(writes).to.equal(0)
    }
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

  it('derives six months from the anchor and never schedules finance after it', async () => {
    records.clear()
    const anchor = new Date('2027-02-03T00:00:00.000Z')
    await runDemoSeed({ target, dryRun: false, database, providers, serviceDate: anchor })
    const sales = [...(records.get('sales')?.values() ?? [])].filter((sale) => String(sale.fixtureKey).startsWith('finance:'))
    expect(new Set(sales.map((sale) => (sale.paidAt as Date).toISOString().slice(0, 7)))).to.deep.equal(new Set(['2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02']))
    for (const collection of ['sales', 'buys', 'expenses']) {
      for (const record of records.get(collection)?.values() ?? []) {
        if (!String(record.fixtureKey).startsWith('finance:')) continue
        expect((record.paidAt ?? record.date) as Date).to.be.at.most(anchor)
      }
    }
    const oldId = [...(records.get('sales')?.entries() ?? [])].find(([, sale]) => sale.fixtureKey === 'finance:sale:2026-10:1')?.[0]
    await runDemoSeed({ target, dryRun: false, database, providers, serviceDate: new Date('2027-03-03T00:00:00.000Z') })
    expect([...records.get('sales')?.entries() ?? []].find(([, sale]) => sale.fixtureKey === 'finance:sale:2026-10:1')?.[0]).to.equal(oldId)
    expect(records.get('sales')?.size).to.equal(20 + 21 * 7)
  })

  it('uses the injected clock as the default service-date anchor', async () => {
    records.clear()
    const clock = new Date('2027-03-04T18:00:00.000Z')
    await runDemoSeed({ target, dryRun: false, database, providers, now: clock })
    expect([...records.get('sales')?.values() ?? []].some((sale) => sale.fixtureKey === 'finance:sale:2027-03')).to.equal(true)
    expect([...records.get('sales')?.values() ?? []].some((sale) => sale.fixtureKey === 'finance:sale:2026-09')).to.equal(false)
    expect([...records.get('sales')?.values() ?? []].filter((sale) => String(sale.fixtureKey).startsWith('finance:')).every((sale) => (sale.paidAt as Date) <= new Date('2027-03-04T00:00:00.000Z'))).to.equal(true)
  })

  it('recovers a partial sequential write by rerunning with the same anchor, leaving unrelated data untouched', async () => {
    records.clear()
    const unrelated = { fixtureNamespace: 'other', fixtureKey: 'operator-record', descripcion: 'Keep me' }
    records.set('categories', new Map([['unrelated-id', unrelated]]))
    let attempts = 0
    const failing: DemoDatabase = {
      collection: (name) => {
        const base = database.collection(name)
        return {
          findOne: base.findOne,
          updateOne: async (filter, update, options) => {
            attempts += 1
            if (attempts === 5) throw new Error('Injected write failure')
            return await base.updateOne(filter, update, options)
          }
        }
      }
    }
    const anchor = new Date('2026-10-21T00:00:00.000Z')
    try {
      await runDemoSeed({ target, dryRun: false, database: failing, providers, serviceDate: anchor })
      expect.fail('Expected injected write failure')
    } catch (error) {
      expect((error as Error).message).to.contain('Injected write failure')
    }
    expect(records.get('categories')?.get('unrelated-id')).to.equal(unrelated)
    expect(records.get('products')?.size).to.equal(1)
    const firstId = [...records.get('products')?.keys() ?? []][0]
    const recovered = await runDemoSeed({ target, dryRun: false, database, providers, serviceDate: anchor })
    expect(recovered.summary?.inserted).to.be.greaterThan(0)
    expect(records.get('products')?.has(firstId)).to.equal(true)
    expect(records.get('categories')?.get('unrelated-id')).to.equal(unrelated)
    expect((await runDemoSeed({ target, dryRun: false, database, providers, serviceDate: anchor })).summary?.inserted).to.equal(0)
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
