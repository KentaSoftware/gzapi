import { expect } from 'chai'
import mongoose, { Types } from 'mongoose'

import RoutePlanModel from '../../src/models/routePlan'
import RoutePlanOperationalModel from '../../src/models/routePlanOperational'
import SaleModel from '../../src/models/sale'
import { assign, createProjection, OperationalProjectionError, recomputeState } from '../../src/services/routePlanOperational'

const TEST_DB_URI = 'mongodb://localhost:27017/gzapi_route_plan_operational_test'

describe('Route operational projection', () => {
  before(async () => { await mongoose.connect(TEST_DB_URI) })
  after(async () => {
    const dbName = mongoose.connection.db?.databaseName
    if (dbName?.endsWith('_test') === true) await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
  })
  beforeEach(async () => {
    await Promise.all([RoutePlanModel.deleteMany({}), RoutePlanOperationalModel.deleteMany({}), SaleModel.deleteMany({})])
  })

  it('S-27: derives pending, in-progress and completed state from selected deliveries', async () => {
    const user = new Types.ObjectId()
    const sales = await SaleModel.create([
      { estado: 'CREATED', total: 10, user, cliente: 'A', idCliente: new Types.ObjectId(), delivery: { status: 'PENDING', serviceDate: new Date() } },
      { estado: 'CREATED', total: 20, user, cliente: 'B', idCliente: new Types.ObjectId(), delivery: { status: 'PENDING', serviceDate: new Date() } }
    ])
    const snapshot = await RoutePlanModel.create({ snapshotVersion: 1, selectedSaleIds: sales.map((sale) => String(sale._id)), planningDate: new Date(), zoneSnapshot: { code: 'N', normalizedName: 'n', name: 'North' }, depot: { name: 'Depot', latitude: 1, longitude: 1 }, stops: [{ clientId: 'client', saleIds: sales.map((sale) => String(sale._id)), sequence: 1, latitude: 1, longitude: 1 }], segments: [], metrics: { distanceMeters: 0, durationSeconds: 0, stopCount: 1 }, algorithm: { name: 'test', version: '1', provider: 'test' }, routingConfigRevision: 1, ruleVersion: 'test', encodedPolyline: 'encoded', warnings: [], audit: { createdBy: String(user), createdAt: new Date() } })

    const pending = await createProjection(String(snapshot._id), { changedBy: String(user) })
    expect(pending.status).to.equal('PENDING')
    await SaleModel.updateOne({ _id: sales[0]._id }, { $set: { delivery: { status: 'DELIVERED', deliveredAt: new Date() } } })
    const partial = await recomputeState(String(snapshot._id), { changedBy: String(user) })
    expect(partial.status).to.equal('IN_PROGRESS')
    await SaleModel.updateOne({ _id: sales[1]._id }, { $set: { delivery: { status: 'DELIVERED', deliveredAt: new Date() } } })
    const complete = await recomputeState(String(snapshot._id), { changedBy: String(user) })
    expect(complete.status).to.equal('COMPLETED')
  })

  it('S-24: rejects a stale assignment version without changing the projection', async () => {
    const sale = await SaleModel.create({ estado: 'CREATED', total: 10, user: new Types.ObjectId(), cliente: 'A', idCliente: new Types.ObjectId(), delivery: { status: 'PENDING', serviceDate: new Date() } })
    const snapshot = await RoutePlanModel.create({ snapshotVersion: 1, selectedSaleIds: [String(sale._id)], planningDate: new Date(), zoneSnapshot: { code: 'N', normalizedName: 'n', name: 'North' }, depot: { name: 'Depot', latitude: 1, longitude: 1 }, stops: [{ clientId: 'client', saleIds: [String(sale._id)], sequence: 1, latitude: 1, longitude: 1 }], segments: [], metrics: { distanceMeters: 0, durationSeconds: 0, stopCount: 1 }, algorithm: { name: 'test', version: '1', provider: 'test' }, routingConfigRevision: 1, ruleVersion: 'test', encodedPolyline: 'encoded', warnings: [], audit: { createdBy: 'creator', createdAt: new Date() } })
    await RoutePlanOperationalModel.create({ snapshotId: String(snapshot._id), status: 'PENDING', sourceDeliveryVersion: 0, assignments: {}, history: [], version: 1 })

    try {
      await assign(String(snapshot._id), { version: 0, driverId: 'driver-1', vehicleId: 'vehicle-1', changedBy: 'operator' })
      throw new Error('expected stale version error')
    } catch (error) {
      expect(error).to.be.instanceOf(OperationalProjectionError)
      expect((error as OperationalProjectionError).code).to.equal('ROUTE_OPERATIONAL_VERSION_CONFLICT')
    }
    const projection = await RoutePlanOperationalModel.findOne({ snapshotId: String(snapshot._id) }).lean()
    expect(projection?.version).to.equal(1)
    expect(projection?.assignments).to.deep.equal({})
  })

  it('TC-025: assignment changes append history and do not mutate snapshot bytes', async () => {
    const sale = await SaleModel.create({ estado: 'CREATED', total: 10, user: new Types.ObjectId(), cliente: 'A', idCliente: new Types.ObjectId(), delivery: { status: 'PENDING', serviceDate: new Date() } })
    const snapshot = await RoutePlanModel.create({ snapshotVersion: 1, selectedSaleIds: [String(sale._id)], planningDate: new Date(), zoneSnapshot: { code: 'N', normalizedName: 'n', name: 'North' }, depot: { name: 'Depot', latitude: 1, longitude: 1 }, stops: [{ clientId: 'client', saleIds: [String(sale._id)], sequence: 1, latitude: 1, longitude: 1 }], segments: [], metrics: { distanceMeters: 0, durationSeconds: 0, stopCount: 1 }, algorithm: { name: 'test', version: '1', provider: 'test' }, routingConfigRevision: 1, ruleVersion: 'test', encodedPolyline: 'encoded', warnings: [], audit: { createdBy: 'creator', createdAt: new Date() } })
    const before = snapshot.toObject()
    await RoutePlanOperationalModel.create({ snapshotId: String(snapshot._id), status: 'PENDING', sourceDeliveryVersion: 0, assignments: {}, history: [], version: 1 })
    const updated = await assign(String(snapshot._id), { version: 1, driverId: 'driver-1', vehicleId: 'vehicle-1', changedBy: 'operator' })
    expect(updated.version).to.equal(2)
    expect(updated.history).to.have.length(1)
    expect((await RoutePlanModel.findById(snapshot._id))?.toObject()).to.deep.equal(before)
  })
})
