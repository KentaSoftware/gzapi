import { strict as assert } from 'assert'
import { randomBytes } from 'crypto'
import mongoose, { Types } from 'mongoose'
import sinon from 'sinon'
import RoutePlanModel from '../../src/models/routePlan'
import SaleModel from '../../src/models/sale'
import ClientModel from '../../src/models/client'
import ZoneModel from '../../src/models/deliveryZone'
import ConfigModel from '../../src/models/routingConfig'
import ReceiptModel from '../../src/models/routePlanPreviewReceipt'
import * as provider from '../../src/services/routeMatrixProvider'
import * as vehicles from '../../src/services/vehicle'
import { getCandidates, preview, saveSnapshot, saveLegacySnapshot } from '../../src/services/routePlan'
import { assignmentGuard, assertAssignmentIndex, ASSIGNMENT_INDEX_NAME, isDuplicateIndexError, unassignedCandidates } from '../../src/services/routeAssignment'
import { assignmentCollectionAdapter, migrateAssignmentIndex, type AssignmentCollection } from '../../migrations/route-plan-005-assignment-index'

const integration = process.env.RUN_ROUTE_ASSIGNMENT_MONGO === '1' ? describe : describe.skip

integration('route assignment local MongoDB integration', function () {
  it('preserves historical snapshots and enforces atomic sparse reservations', async function () {
    const dbName = `gzapi_route_assignment_${randomBytes(16).toString('hex')}`
    const uri = `mongodb://127.0.0.1:27017/${dbName}?directConnection=true`
    const owned: Types.ObjectId[] = []
    let verifiedFresh = false
    let writesStarted = false
    const id = (): Types.ObjectId => { const value = new Types.ObjectId(); owned.push(value); return value }
    const sale = (): string => new Types.ObjectId().toHexString()
    try {
      await mongoose.connect(uri, { autoIndex: false, serverSelectionTimeoutMS: 5000 })
      const db = mongoose.connection.db
      assert.ok(db)
      const databases = await db.admin().listDatabases({ nameOnly: true })
      assert.equal(databases.databases.some((entry) => entry.name === dbName), false, 'refusing an existing database')
      verifiedFresh = true
      const collection = RoutePlanModel.collection
      const version = await db.admin().serverStatus()
      console.log(`MongoDB version: ${String(version.version)}; isolated namespace: ${dbName}`)

      // RED control: without the index both overlapping writers succeed.
      const shared = [sale(), sale()]
      const redIds = [id(), id()]
      writesStarted = true
      const red = await Promise.all(redIds.map(async (_id) => await collection.insertOne({ _id, selectedSaleIds: shared, reservedSaleIds: shared })))
      assert.equal(red.filter((result) => result.acknowledged).length, 2)
      console.log('RED control: 2 overlapping writes succeeded without the index')
      const redCleanup = await collection.deleteMany({ _id: { $in: redIds } })
      assert.equal(redCleanup.deletedCount, 2)

      const historicalSale = sale()
      const historicalIds = [id(), id()]
      await collection.insertMany(historicalIds.map((_id) => ({ _id, selectedSaleIds: [historicalSale], stops: [{ saleId: historicalSale }] })))
      const adapter = assignmentCollectionAdapter(collection as unknown as AssignmentCollection)
      const preview = await migrateAssignmentIndex(adapter)
      assert.equal(preview.status, 'preview')
      assert.equal(preview.audit.snapshots, 2)
      assert.equal(preview.audit.clean, true)
      const applied = await migrateAssignmentIndex(adapter, true)
      assert.equal(applied.status, 'created')
      assert.equal(await collection.countDocuments({ _id: { $in: historicalIds } }), 2)
      await assertAssignmentIndex(assignmentGuard)
      const catalog = await collection.listIndexes().toArray()
      assert.equal(catalog.filter((entry) => entry.name === ASSIGNMENT_INDEX_NAME).length, 1)
      const free = sale()
      assert.deepEqual(await unassignedCandidates(assignmentGuard, [{ saleId: historicalSale }, { saleId: free }]), [{ saleId: free }])

      const overlap = [sale(), sale()]
      const receiptSales = [...overlap, sale()]
      const legacySales = [...overlap, sale()]
      const outcomes = await Promise.allSettled([
        collection.insertOne({ _id: id(), source: 'receipt', selectedSaleIds: receiptSales, reservedSaleIds: receiptSales }),
        collection.insertOne({ _id: id(), source: 'legacy', selectedSaleIds: legacySales, reservedSaleIds: legacySales })
      ])
      assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1)
      const rejected = outcomes.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      assert.ok(rejected)
      assert.equal(isDuplicateIndexError(rejected.reason, 'reservedSaleIds', ASSIGNMENT_INDEX_NAME), true)
      const disjoint = await Promise.all([sale(), sale()].map(async (value) => await collection.insertOne({ _id: id(), selectedSaleIds: [value], reservedSaleIds: [value] })))
      assert.equal(disjoint.filter((result) => result.acknowledged).length, 2)
      console.log('GREEN: overlapping 1 success / 1 duplicate; disjoint 2 successes; historical 2 preserved')

      // Sparse indexes omit missing fields; null and empty arrays are tested independently.
      await collection.insertMany([{ _id: id() }, { _id: id() }])
      await collection.insertOne({ _id: id(), reservedSaleIds: null })
      await assert.rejects(async () => await collection.insertOne({ _id: id(), reservedSaleIds: null }), (error: unknown) => isDuplicateIndexError(error, 'reservedSaleIds', ASSIGNMENT_INDEX_NAME))
      await collection.insertOne({ _id: id(), reservedSaleIds: [] })
      await assert.rejects(async () => await collection.insertOne({ _id: id(), reservedSaleIds: [] }), (error: unknown) => isDuplicateIndexError(error, 'reservedSaleIds', ASSIGNMENT_INDEX_NAME))
      console.log('Sparse behavior: missing 2 accepted; null 1 accepted/1 rejected; empty array 1 accepted/1 rejected')
      const model = new RoutePlanModel({ selectedSaleIds: [sale()] })
      assert.equal(model.reservedSaleIds, undefined)
    } finally {
      try {
        if (verifiedFresh && writesStarted) {
          const collection = RoutePlanModel.collection
          const removed = await collection.deleteMany({ _id: { $in: owned } })
          const remaining = await collection.countDocuments({ _id: { $in: owned } })
          console.log(`Cleanup: ${removed.deletedCount} owned documents removed; ${remaining} owned documents remain (database and indexes retained)`)
          assert.equal(remaining, 0)
        }
      } finally {
        await mongoose.disconnect()
      }
    }
  })

  it('executes receipt and legacy service saves against the reservation index', async function () {
    const dbName = `gzapi_route_service_${randomBytes(16).toString('hex')}`
    const uri = `mongodb://127.0.0.1:27017/${dbName}?directConnection=true`
    const zone = new Types.ObjectId()
    const client = new Types.ObjectId()
    const config = new Types.ObjectId()
    const sales = Array.from({ length: 6 }, () => new Types.ObjectId())
    const actors = Array.from({ length: 6 }, (_, i) => `fixture-${randomBytes(12).toString('hex')}-${i}`)
    const input = (indices: number[]): Parameters<typeof preview>[0] => ({ serviceDate: '2026-11-11', deliveryZoneId: String(zone), saleIds: indices.map((i) => String(sales[i])), driverId: 'driver', vehicleId: 'vehicle' })
    let owned = false
    try {
      await mongoose.connect(uri, { autoIndex: false, serverSelectionTimeoutMS: 5000 })
      const db = mongoose.connection.db
      assert.ok(db)
      const databases = await db.admin().listDatabases({ nameOnly: true })
      assert.equal(databases.databases.some((entry) => entry.name === dbName), false, 'refusing an existing database')
      owned = true
      sinon.stub(provider, 'computeMatrix').callsFake(async ({ origins, destinations }) => ({ segments: origins.flatMap((from) => destinations.filter((to) => from.id !== to.id).map((to) => ({ fromId: from.id, toId: to.id, distanceMeters: 10, durationSeconds: 20 }))) }))
      sinon.stub(provider, 'computeRoute').resolves({ distanceMeters: 20, durationSeconds: 40, encodedPolyline: 'fixture' })
      sinon.stub(vehicles, 'getVehicleById').resolves(null)
      await ZoneModel.collection.insertOne({ _id: zone, active: true, code: 'fixture', name: 'Fixture', normalizedName: 'fixture' })
      await ConfigModel.collection.insertOne({ _id: config, key: 'deposito_1', enabled: true, revision: 1, depot: { name: 'Depot', latitude: 0, longitude: 0 }, provider: 'fixture', algorithm: 'fixture' })
      await ClientModel.collection.insertOne({ _id: client, nombreCompleto: 'Fixture', address: 'Fixture', isActive: true, deliveryZoneId: zone, lat: 1, lng: 2, geocoding: { status: 'CONFIRMED' } })
      await SaleModel.collection.insertMany(sales.map((_id) => ({ _id, idCliente: client, estado: 'Creado', delivery: { status: 'PENDING' } })))
      const reviewed = await preview(input([0, 1]), { actor: actors[0] })
      await assert.rejects(async () => await saveSnapshot({ receipt: reviewed.receipt as string }, actors[0]), { name: 'AssignmentSafetyError' })
      await assert.rejects(async () => await saveLegacySnapshot(input([0, 1]), actors[1]), { name: 'AssignmentSafetyError' })
      const adapter = assignmentCollectionAdapter(RoutePlanModel.collection as unknown as AssignmentCollection)
      assert.equal((await migrateAssignmentIndex(adapter, true)).status, 'created')
      const overlap = await Promise.allSettled([
        saveSnapshot({ receipt: reviewed.receipt as string }, actors[0]),
        saveLegacySnapshot(input([0, 1]), actors[1])
      ])
      assert.equal(overlap.filter((result) => result.status === 'fulfilled').length, 1)
      const conflict = overlap.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      assert.equal((conflict?.reason as Error).name, 'AssignmentConflictError')
      const disjointReceipt = await preview(input([3]), { actor: actors[2] })
      const disjoint = await Promise.all([
        saveSnapshot({ receipt: disjointReceipt.receipt as string }, actors[2]),
        saveLegacySnapshot(input([4]), actors[3])
      ])
      assert.equal(disjoint.length, 2)
      const candidates = await getCandidates(input([0]))
      for (const id of [sales[0], sales[1], sales[3], sales[4]]) assert.equal(candidates.eligible.some((entry) => entry.saleId === String(id)), false)
      const historicalId = new Types.ObjectId()
      await RoutePlanModel.collection.insertOne({ _id: historicalId, selectedSaleIds: [String(sales[5])], stops: [{ saleId: String(sales[5]) }] })
      try {
        await assert.rejects(async () => await saveLegacySnapshot(input([5]), actors[4]), { name: 'AssignmentConflictError' })
      } finally {
        await RoutePlanModel.collection.deleteOne({ _id: historicalId })
      }
      console.log('Service GREEN: overlap 1 success/1 conflict; disjoint 2 successes; missing index and historical assignment rejected')
    } finally {
      sinon.restore()
      try {
        if (owned) {
          const snapshots = await RoutePlanModel.collection.find({ 'audit.createdBy': { $in: actors } }, { projection: { _id: 1 } }).toArray()
          const snapshotIds = snapshots.map((snapshot) => snapshot._id)
          await RoutePlanModel.collection.deleteMany({ _id: { $in: snapshotIds } })
          await ReceiptModel.collection.deleteMany({ _id: { $in: actors } })
          await SaleModel.collection.deleteMany({ _id: { $in: sales } })
          await ClientModel.collection.deleteOne({ _id: client })
          await ZoneModel.collection.deleteOne({ _id: zone })
          await ConfigModel.collection.deleteOne({ _id: config })
          assert.equal(await RoutePlanModel.collection.countDocuments({ _id: { $in: snapshotIds } }), 0)
          assert.equal(await ReceiptModel.collection.countDocuments({ _id: { $in: actors } }), 0)
          assert.equal(await SaleModel.collection.countDocuments({ _id: { $in: sales } }), 0)
          assert.equal(await ClientModel.collection.countDocuments({ _id: client }), 0)
          assert.equal(await ZoneModel.collection.countDocuments({ _id: zone }), 0)
          assert.equal(await ConfigModel.collection.countDocuments({ _id: config }), 0)
          console.log(`Service cleanup: ${snapshotIds.length} owned snapshots removed; 0 owned fixtures remain; database and indexes retained`)
        }
      } finally { await mongoose.disconnect() }
    }
  })
})
