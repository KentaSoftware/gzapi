import { expect } from 'chai'
import mongoose, { Types } from 'mongoose'
import request from 'supertest'

import RoutePlanOperationalModel from '../../src/models/routePlanOperational'
import RoutePlanModel from '../../src/models/routePlan'
import RoleModel from '../../src/models/role'
import SaleModel from '../../src/models/sale'
import UserModel from '../../src/models/user'
import { generateToken } from '../../src/utils/jwt.handle'

const TEST_DB_URI = 'mongodb://localhost:27017/gzapi_route_plan_staleness_api_test'

interface CreatedSnapshot {
  _id: Types.ObjectId
  selectedSaleIds: string[]
}

describe('Route snapshot staleness API', () => {
  let app: Awaited<ReturnType<typeof import('../../src/app').createApp>>
  let token: string
  let userId: Types.ObjectId

  before(async () => {
    await mongoose.connect(TEST_DB_URI)
    const { createApp } = await import('../../src/app')
    app = await createApp()
  })

  after(async () => {
    const dbName = mongoose.connection.db?.databaseName
    if (dbName?.endsWith('_test') === true) await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
  })

  beforeEach(async () => {
    await Promise.all([
      RoutePlanModel.deleteMany({}),
      RoutePlanOperationalModel.deleteMany({}),
      RoleModel.deleteMany({}),
      SaleModel.deleteMany({}),
      UserModel.deleteMany({})
    ])
    const role = await RoleModel.create({ name: 'Staleness reader', permissions: ['read_route_plan'] })
    const user = await UserModel.create({ nickname: 'staleness-reader', password: 'not-a-real-password', role: role._id })
    userId = user._id
    token = await generateToken(user)
  })

  const createSnapshot = async (withReference = true): Promise<CreatedSnapshot> => {
    const sale = await SaleModel.create({
      estado: 'CREATED',
      total: 10,
      user: userId,
      cliente: 'A',
      idCliente: new Types.ObjectId(),
      delivery: { status: 'PENDING', serviceDate: new Date() }
    })
    const snapshot = await RoutePlanModel.create({
      snapshotVersion: 1,
      selectedSaleIds: [String(sale._id)],
      planningDate: new Date(),
      zoneSnapshot: { code: 'N', normalizedName: 'n', name: 'North' },
      depot: { name: 'Depot', latitude: 1, longitude: 1 },
      stops: [{ clientId: 'client', saleIds: [String(sale._id)], sequence: 1, latitude: 1, longitude: 1 }],
      segments: [],
      metrics: { distanceMeters: 0, durationSeconds: 0, stopCount: 1 },
      algorithm: { name: 'test', version: '1', provider: 'test' },
      routingConfigRevision: 1,
      ruleVersion: 'test',
      encodedPolyline: 'encoded',
      warnings: [],
      audit: { createdBy: String(userId), createdAt: new Date() },
      ...(withReference ? { saleReferences: [{ saleId: String(sale._id), versionAtSave: sale.updatedAt.getTime(), statusAtSave: 'PENDING' }] } : {})
    })
    return snapshot as unknown as CreatedSnapshot
  }

  it('FR-048: list reads compare referenced sales and expose stale evidence', async () => {
    const snapshot = await createSnapshot()
    await SaleModel.updateOne({ _id: snapshot.selectedSaleIds[0] }, { $set: { 'delivery.status': 'DELIVERED', 'delivery.deliveredAt': new Date() } })

    const response = await request(app).get('/routePlan').set('Authorization', `Bearer ${token}`)

    expect(response.status).to.equal(200)
    expect(response.body[0].staleness.stale).to.equal(true)
    expect(response.body[0].staleness.causes).to.deep.equal(['MODIFIED'])
  })

  it('FR-049: detail reads include current sale evidence and an actionable warning', async () => {
    const snapshot = await createSnapshot()
    await SaleModel.updateOne({ _id: snapshot.selectedSaleIds[0] }, { $set: { estado: 'CANCELLED' } })

    const response = await request(app).get(`/routePlan/${String(snapshot._id)}`).set('Authorization', `Bearer ${token}`)

    expect(response.status).to.equal(200)
    expect(response.body.staleness.saleRefs[0].currentStatus).to.equal('PENDING')
    expect(response.body.readWarnings).to.include('STALE_ROUTE_PLAN_REQUIRES_REPLANNING')
  })

  it('FR-050: stale reads update the separate operational projection without rewriting snapshot bytes', async () => {
    const snapshot = await createSnapshot()
    await RoutePlanOperationalModel.create({ snapshotId: String(snapshot._id), status: 'PENDING', sourceDeliveryVersion: 0, assignments: {}, history: [], version: 1 })
    const before = JSON.stringify((await RoutePlanModel.findById(snapshot._id))?.toObject())
    await SaleModel.updateOne({ _id: snapshot.selectedSaleIds[0] }, { $set: { 'delivery.status': 'DELIVERED', 'delivery.deliveredAt': new Date() } })

    const response = await request(app).get(`/routePlan/${String(snapshot._id)}`).set('Authorization', `Bearer ${token}`)
    const projection = await RoutePlanOperationalModel.findOne({ snapshotId: String(snapshot._id) }).lean()

    expect(response.status).to.equal(200)
    expect(projection?.stale).to.equal(true)
    expect(JSON.stringify((await RoutePlanModel.findById(snapshot._id))?.toObject())).to.equal(before)
  })

  it('FR-051: stale response requires a new route while preserving the historical snapshot', async () => {
    const snapshot = await createSnapshot()
    await SaleModel.updateOne({ _id: snapshot.selectedSaleIds[0] }, { $set: { 'delivery.status': 'DELIVERED', 'delivery.deliveredAt': new Date() } })

    const response = await request(app).get(`/routePlan/${String(snapshot._id)}`).set('Authorization', `Bearer ${token}`)

    expect(response.body.readWarnings).to.include('STALE_ROUTE_PLAN_REQUIRES_REPLANNING')
    expect(response.body.selectedSaleIds).to.deep.equal(snapshot.selectedSaleIds)
  })

  it('FR-055: legacy snapshots remain readable with unknown non-stale evidence', async () => {
    const snapshot = await createSnapshot(false)

    const response = await request(app).get(`/routePlan/${String(snapshot._id)}`).set('Authorization', `Bearer ${token}`)

    expect(response.status).to.equal(200)
    expect(response.body.staleness).to.equal(null)
    expect(response.body.readWarnings).to.deep.equal([])
  })
})
