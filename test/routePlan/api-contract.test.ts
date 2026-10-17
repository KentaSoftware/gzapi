import { expect } from 'chai'
import mongoose, { Types } from 'mongoose'
import request from 'supertest'
import sinon from 'sinon'

import ClientModel from '../../src/models/client'
import DeliveryZoneModel from '../../src/models/deliveryZone'
import RoleModel from '../../src/models/role'
import RoutePlanModel from '../../src/models/routePlan'
import RoutePlanOperationalModel from '../../src/models/routePlanOperational'
import RoutingConfigModel from '../../src/models/routingConfig'
import SaleModel from '../../src/models/sale'
import UserModel from '../../src/models/user'
import VehicleModel from '../../src/models/vehicle'
import * as routeMatrixProvider from '../../src/services/routeMatrixProvider'
import { generateToken } from '../../src/utils/jwt.handle'

const TEST_DB_URI = 'mongodb://localhost:27017/gzapi_route_plan_api_contract_test'
const SERVICE_DATE = '2026-10-12'
const SERVICE_DAY_START = new Date('2026-10-12T03:00:00.000Z')

describe('Route plan API contract', () => {
  let app: Awaited<ReturnType<typeof import('../../src/app').createApp>>
  let readToken: string
  let createToken: string
  let readUserId: Types.ObjectId
  let zoneId: Types.ObjectId

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
      ClientModel.deleteMany({}),
      DeliveryZoneModel.deleteMany({}),
      RoleModel.deleteMany({}),
      RoutePlanModel.deleteMany({}),
      RoutePlanOperationalModel.deleteMany({}),
      RoutingConfigModel.deleteMany({}),
      SaleModel.deleteMany({}),
      UserModel.deleteMany({}),
      VehicleModel.deleteMany({})
    ])

    const readRole = await RoleModel.create({ name: 'Authenticated API route user', permissions: [] })
    const createRole = await RoleModel.create({ name: 'Authenticated API route creator', permissions: [] })
    const readUser = await UserModel.create({ nickname: 'api-route-reader', password: 'not-a-real-password', role: readRole._id })
    const createUser = await UserModel.create({ nickname: 'api-route-creator', password: 'not-a-real-password', role: createRole._id })
    readUserId = readUser._id
    readToken = await generateToken(readUser)
    createToken = await generateToken(createUser)
    const zone = await DeliveryZoneModel.create({ code: 'NORTE', normalizedName: 'norte', name: 'Norte', active: true })
    zoneId = zone._id
  })

  afterEach(() => { sinon.restore() })

  const createSale = async (): Promise<Types.ObjectId> => {
    const sale = await SaleModel.create({
      estado: 'CREATED',
      total: 100,
      user: readUserId,
      cliente: 'API customer',
      idCliente: new Types.ObjectId(),
      delivery: { status: 'PENDING', serviceDate: SERVICE_DAY_START }
    })
    return sale._id
  }

  const createSnapshot = async (withReference = true): Promise<Types.ObjectId> => {
    const saleId = await createSale()
    const snapshot = await RoutePlanModel.create({
      snapshotVersion: 1,
      planningDate: SERVICE_DAY_START,
      zoneSnapshot: { code: 'NORTE', normalizedName: 'norte', name: 'Norte' },
      selectedSaleIds: [String(saleId)],
      depot: { name: 'Deposito 1', latitude: -34.6, longitude: -58.4 },
      stops: [{ clientId: 'client-1', saleIds: [String(saleId)], sequence: 1, latitude: -34.61, longitude: -58.41 }],
      segments: [],
      metrics: { distanceMeters: 12000, durationSeconds: 900, stopCount: 1, fuelLiters: 1.2 },
      assignments: { driverId: 'driver-1', vehicleId: 'vehicle-1' },
      algorithm: { name: 'heuristic', version: '1', provider: 'internal' },
      routingConfigRevision: 1,
      ruleVersion: 'candidate-eligibility-v1',
      encodedPolyline: 'encoded-route',
      warnings: [],
      audit: { createdBy: String(readUserId), createdAt: new Date() },
      ...(withReference ? { saleReferences: [{ saleId: String(saleId), versionAtSave: Date.now(), statusAtSave: 'PENDING' }] } : {})
    })
    return snapshot._id
  }

  it('TC-010/TC-011/TC-016/TC-020: protects dashboard reads with JWT and validates bounded filters', async () => {
    const unauthenticated = await request(app).get(`/routePlan/dashboard?serviceDate=${SERVICE_DATE}&zoneCode=NORTE`)
    expect(unauthenticated.status).to.equal(401)

    const valid = await request(app)
      .get(`/routePlan/dashboard?serviceDate=${SERVICE_DATE}&zoneCode=NORTE&status=PENDING`)
      .set('Authorization', `Bearer ${readToken}`)
    expect(valid.status).to.equal(200)
    expect(valid.body).to.include.keys(['kpis', 'routes', 'candidates', 'warnings'])

    const invalidDate = await request(app)
      .get('/routePlan/dashboard?serviceDate=2026-02-30&zoneCode=NORTE')
      .set('Authorization', `Bearer ${readToken}`)
    const invalidStatus = await request(app)
      .get(`/routePlan/dashboard?serviceDate=${SERVICE_DATE}&zoneCode=NORTE&status=INVALID`)
      .set('Authorization', `Bearer ${readToken}`)
    expect(invalidDate.status).to.equal(400)
    expect(invalidStatus.status).to.equal(400)

    const forbiddenRole = await RoleModel.create({ name: 'No route permission', permissions: ['read_sale'] })
    const forbiddenUser = await UserModel.create({ nickname: 'no-route-permission', password: 'not-a-real-password', role: forbiddenRole._id })
    const forbidden = await request(app)
      .get(`/routePlan/dashboard?serviceDate=${SERVICE_DATE}&zoneCode=NORTE`)
      .set('Authorization', `Bearer ${await generateToken(forbiddenUser)}`)
    expect(forbidden.status).to.equal(200)
  })

  it('TC-033: returns bounded selected-route detail and preserves dashboard limit warnings', async () => {
    await createSnapshot()
    const response = await request(app)
      .get(`/routePlan/dashboard?serviceDate=${SERVICE_DATE}&zoneCode=NORTE`)
      .set('Authorization', `Bearer ${readToken}`)

    expect(response.status).to.equal(200)
    expect(response.body.routes[0]).to.include.keys(['depot', 'stops', 'segments', 'assignments'])
    expect(response.body.routes[0].stops).to.have.length(1)
    expect(response.body.routes[0].stops[0].sequence).to.equal(1)
    expect(response.body.routes[0].stops[0].saleIds).to.deep.equal(response.body.routes[0].selectedSaleIds)
  })

  it('TC-026/TC-030: rejects preview and save without assignments before provider or snapshot work', async () => {
    const providerMatrix = sinon.stub(routeMatrixProvider, 'computeMatrix').rejects(new Error('provider must not be called'))
    const providerRoute = sinon.stub(routeMatrixProvider, 'computeRoute').rejects(new Error('provider must not be called'))
    const body = { serviceDate: SERVICE_DATE, deliveryZoneId: String(zoneId), saleIds: [new Types.ObjectId().toString()] }

    const preview = await request(app).post('/routePlan/preview').set('Authorization', `Bearer ${createToken}`).send(body)
    const save = await request(app).post('/routePlan').set('Authorization', `Bearer ${createToken}`).send(body)

    expect(preview.status).to.equal(422)
    expect(preview.body.code).to.equal('ROUTE_ASSIGNMENT_REQUIRED')
    expect(save.status).to.equal(422)
    expect(save.body.code).to.equal('ROUTE_ASSIGNMENT_REQUIRED')
    expect(await RoutePlanModel.countDocuments()).to.equal(0)
    expect(providerMatrix.called).to.equal(false)
    expect(providerRoute.called).to.equal(false)
  })

  it('TC-024/TC-025: updates operational assignments and reports malformed, missing and stale requests', async () => {
    const snapshotId = await createSnapshot()
    const success = await request(app)
      .patch(`/routePlan/${String(snapshotId)}/operational`)
      .set('Authorization', `Bearer ${createToken}`)
      .send({ version: 1, driverId: 'driver-2', vehicleId: 'vehicle-2' })
    expect(success.status).to.equal(200)
    expect(success.body).to.include({ snapshotId: String(snapshotId), version: 2 })
    expect(success.body.assignments).to.deep.equal({ driverId: 'driver-2', vehicleId: 'vehicle-2' })

    const malformed = await request(app)
      .patch(`/routePlan/${String(snapshotId)}/operational`)
      .set('Authorization', `Bearer ${createToken}`)
      .send({ version: '2', driverId: 'driver-3', vehicleId: 'vehicle-3' })
    expect(malformed.status).to.equal(400)

    const missing = await request(app)
      .patch(`/routePlan/${new Types.ObjectId().toString()}/operational`)
      .set('Authorization', `Bearer ${createToken}`)
      .send({ version: 1, driverId: 'driver-3', vehicleId: 'vehicle-3' })
    expect(missing.status).to.equal(404)

    const conflict = await request(app)
      .patch(`/routePlan/${String(snapshotId)}/operational`)
      .set('Authorization', `Bearer ${createToken}`)
      .send({ version: 1, driverId: 'driver-3', vehicleId: 'vehicle-3' })
    expect(conflict.status).to.equal(409)
    expect(conflict.body.code).to.equal('ROUTE_OPERATIONAL_VERSION_CONFLICT')
  })

  it('TC-012/TC-021/TC-023/TC-031: exposes stale list and detail reads without mutating legacy snapshots', async () => {
    const snapshotId = await createSnapshot()
    const before = JSON.stringify((await RoutePlanModel.findById(snapshotId))?.toObject())
    const saleId = (await RoutePlanModel.findById(snapshotId).lean())?.selectedSaleIds[0]
    await SaleModel.updateOne({ _id: saleId }, { $set: { 'delivery.status': 'DELIVERED', 'delivery.deliveredAt': new Date() } })

    const list = await request(app).get('/routePlan').set('Authorization', `Bearer ${readToken}`)
    const detail = await request(app).get(`/routePlan/${String(snapshotId)}`).set('Authorization', `Bearer ${readToken}`)
    expect(list.status).to.equal(200)
    expect(list.body[0].staleness.stale).to.equal(true)
    expect(detail.status).to.equal(200)
    expect(detail.body.readWarnings).to.include('STALE_ROUTE_PLAN_REQUIRES_REPLANNING')
    expect(JSON.stringify((await RoutePlanModel.findById(snapshotId))?.toObject())).to.equal(before)

    const legacyId = await createSnapshot(false)
    const legacy = await request(app).get(`/routePlan/${String(legacyId)}`).set('Authorization', `Bearer ${readToken}`)
    expect(legacy.status).to.equal(200)
    expect(legacy.body.staleness).to.equal(null)
    expect(legacy.body.readWarnings).to.deep.equal([])
  })

  it('TC-013/TC-014/TC-022/TC-032: returns precise snapshot identifier errors and assignment option shape', async () => {
    const invalid = await request(app).get('/routePlan/not-an-object-id').set('Authorization', `Bearer ${readToken}`)
    const missing = await request(app).get(`/routePlan/${new Types.ObjectId().toString()}`).set('Authorization', `Bearer ${readToken}`)
    expect(invalid.status).to.equal(400)
    expect(missing.status).to.equal(404)

    await UserModel.create({ nickname: 'available-driver', password: 'not-a-real-password', isActive: true })
    await VehicleModel.create({ code: 'AA123AA', fuelConsumptionLitersPer100Km: 12.5, attributes: { type: 'van' }, active: true })
    const unauthenticatedOptions = await request(app).get('/routePlan/assignment-options')
    expect(unauthenticatedOptions.status).to.equal(401)
    const forbiddenRole = await RoleModel.create({ name: 'Assignment options denied', permissions: ['read_sale'] })
    const forbiddenUser = await UserModel.create({ nickname: 'assignment-options-denied', password: 'not-a-real-password', role: forbiddenRole._id })
    const forbiddenOptions = await request(app)
      .get('/routePlan/assignment-options')
      .set('Authorization', `Bearer ${await generateToken(forbiddenUser)}`)
    expect(forbiddenOptions.status).to.equal(200)
    const options = await request(app).get('/routePlan/assignment-options').set('Authorization', `Bearer ${readToken}`)
    expect(options.status).to.equal(200)
    expect(options.body).to.have.keys(['drivers', 'vehicles'])
    expect(options.body.drivers.some((driver: { nickname: string, isActive: boolean }) => driver.nickname === 'available-driver' && driver.isActive)).to.equal(true)
    expect(options.body.vehicles.some((vehicle: { code: string, fuelConsumptionLitersPer100Km: number, availability: boolean }) => vehicle.code === 'AA123AA' && vehicle.fuelConsumptionLitersPer100Km === 12.5 && vehicle.availability)).to.equal(true)
  })
})
