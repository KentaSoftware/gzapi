import { expect } from 'chai'
import mongoose, { Types } from 'mongoose'
import request from 'supertest'
import sinon from 'sinon'

import ClientModel from '../src/models/client'
import DeliveryZoneModel from '../src/models/deliveryZone'
import RoleModel from '../src/models/role'
import RoutePlanModel from '../src/models/routePlan'
import RoutingConfigModel from '../src/models/routingConfig'
import SaleModel from '../src/models/sale'
import UserModel from '../src/models/user'
import * as routeMatrixProvider from '../src/services/routeMatrixProvider'
import { generateToken } from '../src/utils/jwt.handle'

const TEST_DB_URI = 'mongodb://localhost:27017/gzapi_route_plan_snapshot_test'
const SERVICE_DATE = '2026-10-05'
const SERVICE_DAY_START = new Date('2026-10-05T03:00:00.000Z')

describe('Route plan snapshots', () => {
  let app: Awaited<ReturnType<typeof import('../src/app').createApp>>
  let authorizedToken: string
  let unauthorizedToken: string
  let userId: Types.ObjectId
  let zoneId: Types.ObjectId

  const snapshotRequest = (saleIds: Types.ObjectId[]): request.Test => request(app)
    .post('/routePlan')
    .set('Authorization', `Bearer ${authorizedToken}`)
    .send({ serviceDate: SERVICE_DATE, deliveryZoneId: String(zoneId), saleIds: saleIds.map(String) })

  const configureRoute = async (): Promise<void> => {
    await RoutingConfigModel.create({
      key: 'deposito_1',
      enabled: true,
      revision: 3,
      depot: { name: 'Deposito 1', latitude: -34.6, longitude: -58.4 },
      fuelConsumptionLitersPer100Km: 8.5,
      provider: 'google-routes',
      algorithm: 'nearest-neighbor-2opt-v1'
    })
  }

  const createEligibleSale = async (name: string, latitude: number, longitude: number): Promise<Types.ObjectId> => {
    const client = await ClientModel.create({
      nombreCompleto: name,
      address: `${name} address`,
      lat: latitude,
      lng: longitude,
      isActive: true,
      deliveryZoneId: zoneId,
      geocoding: { status: 'CONFIRMED', source: 'GEOCODED', validatedAt: new Date(), validatedBy: userId }
    })
    const sale = await SaleModel.create({
      estado: 'CREATED',
      total: 100,
      user: userId,
      cliente: name,
      idCliente: client._id,
      delivery: { status: 'PENDING', serviceDate: SERVICE_DAY_START }
    })
    return sale._id
  }

  before(async () => {
    await mongoose.connect(TEST_DB_URI)
    const { createApp } = await import('../src/app')
    app = await createApp()
  })

  after(async () => {
    sinon.restore()
    const dbName = mongoose.connection.db?.databaseName
    if (dbName?.endsWith('_test') === true) await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
  })

  beforeEach(async () => {
    sinon.restore()
    await Promise.all([
      RoutePlanModel.deleteMany({}),
      SaleModel.deleteMany({}),
      ClientModel.deleteMany({}),
      DeliveryZoneModel.deleteMany({}),
      RoutingConfigModel.deleteMany({}),
      UserModel.deleteMany({}),
      RoleModel.deleteMany({})
    ])
    const authorizedRole = await RoleModel.create({ name: 'Route planner', permissions: ['create_route_plan', 'read_route_plan'] })
    const unauthorizedRole = await RoleModel.create({ name: 'Sales reader', permissions: ['read_sale'] })
    const authorizedUser = await UserModel.create({ nickname: 'route-planner', password: 'not-a-real-password', role: authorizedRole._id })
    const unauthorizedUser = await UserModel.create({ nickname: 'sales-reader', password: 'not-a-real-password', role: unauthorizedRole._id })
    userId = authorizedUser._id
    authorizedToken = await generateToken(authorizedUser)
    unauthorizedToken = await generateToken(unauthorizedUser)
    const zone = await DeliveryZoneModel.create({ code: 'NORTE', normalizedName: 'norte', name: 'Norte', active: true })
    zoneId = zone._id
  })

  it('S-25/TC-017: requires authentication and the matching permissions for snapshot save and reads', async () => {
    const matrix = sinon.stub(routeMatrixProvider, 'computeMatrix')
    const finalRoute = sinon.stub(routeMatrixProvider, 'computeRoute')
    const unauthenticatedSave = await request(app).post('/routePlan').send({ serviceDate: SERVICE_DATE, deliveryZoneId: String(zoneId), saleIds: [String(new Types.ObjectId())] })
    const forbiddenSave = await request(app).post('/routePlan').set('Authorization', `Bearer ${unauthorizedToken}`).send({ serviceDate: SERVICE_DATE, deliveryZoneId: String(zoneId), saleIds: [String(new Types.ObjectId())] })
    const unauthenticatedRead = await request(app).get('/routePlan')
    const forbiddenRead = await request(app).get('/routePlan').set('Authorization', `Bearer ${unauthorizedToken}`)

    expect(unauthenticatedSave.status).to.equal(401)
    expect(forbiddenSave.status).to.equal(403)
    expect(unauthenticatedRead.status).to.equal(401)
    expect(forbiddenRead.status).to.equal(403)
    expect(matrix.called).to.equal(false)
    expect(finalRoute.called).to.equal(false)
    expect(await RoutePlanModel.countDocuments({})).to.equal(0)
  })

  it('S-03/TC-013: creates a new immutable grouped snapshot for every successful request and reads it without providers', async () => {
    const firstSaleId = await createEligibleSale('First customer', -34.61, -58.41)
    const firstSale = await SaleModel.findById(firstSaleId).lean()
    const secondSale = await SaleModel.create({
      estado: 'CREATED',
      total: 100,
      user: userId,
      cliente: 'First customer',
      idCliente: firstSale?.idCliente,
      delivery: { status: 'PENDING', serviceDate: SERVICE_DAY_START }
    })
    const secondSaleId = secondSale._id
    await configureRoute()
    sinon.stub(routeMatrixProvider, 'computeMatrix').callsFake(async ({ origins }) => ({
      segments: origins.flatMap((from, fromIndex) => origins.filter((to) => to.id !== from.id).map((to, toIndex) => ({ fromId: from.id, toId: to.id, distanceMeters: (fromIndex + toIndex + 1) * 1000, durationSeconds: (fromIndex + toIndex + 1) * 60 })))
    }))
    sinon.stub(routeMatrixProvider, 'computeRoute').resolves({ encodedPolyline: 'encoded-route', distanceMeters: 12000, durationSeconds: 900 })
    const salesBefore = await SaleModel.find({}).sort({ _id: 1 }).lean()
    const clientsBefore = await ClientModel.find({}).sort({ _id: 1 }).lean()

    const firstSave = await snapshotRequest([firstSaleId, secondSaleId])
    const secondSave = await snapshotRequest([firstSaleId, secondSaleId])

    expect(firstSave.status).to.equal(201)
    expect(secondSave.status).to.equal(201)
    expect(firstSave.body._id).to.not.equal(secondSave.body._id)
    expect(firstSave.body.snapshotVersion).to.equal(1)
    expect(firstSave.body.ruleVersion).to.equal('candidate-eligibility-v1')
    expect(firstSave.body.metrics).to.deep.equal({ distanceMeters: 12000, durationSeconds: 900, stopCount: 1, fuelLiters: 1.02 })
    expect(firstSave.body.stops).to.deep.equal([{ clientId: firstSave.body.stops[0].clientId, saleIds: [String(firstSaleId), String(secondSaleId)], sequence: 1, latitude: -34.61, longitude: -58.41 }])
    expect(await SaleModel.find({}).sort({ _id: 1 }).lean()).to.deep.equal(salesBefore)
    expect(await ClientModel.find({}).sort({ _id: 1 }).lean()).to.deep.equal(clientsBefore)

    const persistedSale = await SaleModel.findById(firstSaleId).lean()
    expect(persistedSale?.estado).to.equal('CREATED')
    expect(persistedSale?.delivery?.status).to.equal('PENDING')
    expect(persistedSale?.delivery?.deliveredAt).to.equal(undefined)
    expect(await RoutePlanModel.countDocuments({})).to.equal(2)

    sinon.restore()
    const providerOutage = sinon.stub(routeMatrixProvider, 'computeMatrix').rejects(new Error('provider should not be called'))
    const firstSnapshotId: string = firstSave.body._id
    const list = await request(app).get('/routePlan').set('Authorization', `Bearer ${authorizedToken}`)
    const byId = await request(app).get(`/routePlan/${firstSnapshotId}`).set('Authorization', `Bearer ${authorizedToken}`)

    expect(list.status).to.equal(200)
    expect(list.body).to.have.length(2)
    expect(byId.status).to.equal(200)
    expect(byId.body._id).to.equal(firstSave.body._id)
    expect(byId.body).to.deep.equal(firstSave.body)
    expect(providerOutage.called).to.equal(false)
  })

  it('S-24: saving a suggestion never executes logistics or changes sale state', async () => {
    const saleId = await createEligibleSale('Logistics customer', -34.61, -58.41)
    await configureRoute()
    sinon.stub(routeMatrixProvider, 'computeMatrix').callsFake(async ({ origins }) => ({
      segments: origins.flatMap((from, fromIndex) => origins.filter((to) => to.id !== from.id).map((to, toIndex) => ({ fromId: from.id, toId: to.id, distanceMeters: (fromIndex + toIndex + 1) * 1000, durationSeconds: (fromIndex + toIndex + 1) * 60 })))
    }))
    sinon.stub(routeMatrixProvider, 'computeRoute').resolves({ encodedPolyline: 'encoded-route', distanceMeters: 12000, durationSeconds: 900 })

    const response = await snapshotRequest([saleId])

    expect(response.status).to.equal(201)
    const sale = await SaleModel.findById(saleId).lean()
    expect(sale?.estado).to.equal('CREATED')
    expect(sale?.delivery?.status).to.equal('PENDING')
    expect(sale?.delivery?.deliveredAt).to.equal(undefined)

    const snapshot = await RoutePlanModel.findById(response.body._id).lean()
    for (const executionField of ['assignedVehicle', 'assignedDriver', 'driver', 'vehicle', 'executedAt', 'startedAt', 'routeStatus']) {
      expect(snapshot).to.not.have.property(executionField)
    }

    const startAction = await request(app)
      .post(`/routePlan/${String(response.body._id)}/start`)
      .set('Authorization', `Bearer ${authorizedToken}`)
    expect(startAction.status).to.equal(404)
  })
})
