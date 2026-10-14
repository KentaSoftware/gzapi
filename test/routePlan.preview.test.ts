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
import VehicleModel from '../src/models/vehicle'
import * as routeMatrixProvider from '../src/services/routeMatrixProvider'
import { generateToken } from '../src/utils/jwt.handle'

const TEST_DB_URI = 'mongodb://localhost:27017/gzapi_route_plan_preview_test'
const SERVICE_DATE = '2026-10-05'
const SERVICE_DAY_START = new Date('2026-10-05T03:00:00.000Z')

describe('Route plan preview', () => {
  let app: Awaited<ReturnType<typeof import('../src/app').createApp>>
  let authorizedToken: string
  let unauthorizedToken: string
  let configAdminToken: string
  let configAdminUserId: string
  let userId: Types.ObjectId
  let zoneId: Types.ObjectId
  let vehicleId: Types.ObjectId

  const createEligibleClient = async (name: string, latitude: number, longitude: number): Promise<Types.ObjectId> => {
    const client = await ClientModel.create({
      nombreCompleto: name,
      address: `${name} address`,
      lat: latitude,
      lng: longitude,
      isActive: true,
      deliveryZoneId: zoneId,
      geocoding: { status: 'CONFIRMED', source: 'GEOCODED', validatedAt: new Date(), validatedBy: userId }
    })
    return client._id
  }

  const createSale = async (clientId: Types.ObjectId): Promise<Types.ObjectId> => {
    const sale = await SaleModel.create({
      estado: 'CREATED',
      total: 100,
      user: userId,
      cliente: 'Delivery customer',
      idCliente: clientId,
      delivery: { status: 'PENDING', serviceDate: SERVICE_DAY_START }
    })
    return sale._id
  }

  const configureRouting = async (): Promise<void> => {
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

  const setMaxStops = async (maxStops: number): Promise<void> => {
    await RoutingConfigModel.updateOne({ key: 'deposito_1' }, { $set: { maxStops } })
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
      VehicleModel.deleteMany({}),
      UserModel.deleteMany({}),
      RoleModel.deleteMany({})
    ])

    const authorizedRole = await RoleModel.create({ name: 'Route planner', permissions: ['create_route_plan'] })
    const unauthorizedRole = await RoleModel.create({ name: 'Sales reader', permissions: ['read_sale'] })
    const configAdminRole = await RoleModel.create({ name: 'Route config manager', permissions: ['manage_route_config', 'read_route_plan'] })
    const authorizedUser = await UserModel.create({ nickname: 'route-planner', password: 'not-a-real-password', role: authorizedRole._id })
    const unauthorizedUser = await UserModel.create({ nickname: 'sales-reader', password: 'not-a-real-password', role: unauthorizedRole._id })
    const configAdminUser = await UserModel.create({ nickname: 'route-config-manager', password: 'not-a-real-password', role: configAdminRole._id })
    userId = authorizedUser._id
    authorizedToken = await generateToken(authorizedUser)
    unauthorizedToken = await generateToken(unauthorizedUser)
    configAdminToken = await generateToken(configAdminUser)
    configAdminUserId = String(configAdminUser._id)
    const zone = await DeliveryZoneModel.create({ code: 'NORTE', normalizedName: 'norte', name: 'Norte', active: true })
    zoneId = zone._id
    const vehicle = await VehicleModel.create({ code: 'TEST-ROUTE-01', fuelConsumptionLitersPer100Km: 8.5, active: true })
    vehicleId = vehicle._id
  })

  const previewRequest = (saleIds: Types.ObjectId[]): request.Test => request(app)
    .post('/routePlan/preview')
    .set('Authorization', `Bearer ${authorizedToken}`)
    .send({ serviceDate: SERVICE_DATE, deliveryZoneId: String(zoneId), saleIds: saleIds.map(String), driverId: String(userId), vehicleId: String(vehicleId) })

  it('S-25/TC-017: requires authentication before preview work', async () => {
    const matrix = sinon.stub(routeMatrixProvider, 'computeMatrix')
    const finalRoute = sinon.stub(routeMatrixProvider, 'computeRoute')
    const unauthenticated = await request(app).post('/routePlan/preview').send({ serviceDate: SERVICE_DATE, deliveryZoneId: String(zoneId), saleIds: [String(new Types.ObjectId())] })
    const forbidden = await request(app).post('/routePlan/preview').set('Authorization', `Bearer ${unauthorizedToken}`).send({ serviceDate: SERVICE_DATE, deliveryZoneId: String(zoneId), saleIds: [String(new Types.ObjectId())] })

    expect(unauthenticated.status).to.equal(401)
    expect(unauthenticated.body.code).to.equal('AUTHENTICATION_INVALID')
    expect(forbidden.status).to.equal(422)
    expect(forbidden.body.code).to.equal('ROUTE_ASSIGNMENT_REQUIRED')
    expect(matrix.called).to.equal(false)
    expect(finalRoute.called).to.equal(false)
    expect(await RoutePlanModel.countDocuments({})).to.equal(0)
  })

  it('S-20: rejects invalid input and duplicate selected sales', async () => {
    const saleId = new Types.ObjectId()
    const missing = await request(app).post('/routePlan/preview').set('Authorization', `Bearer ${authorizedToken}`).send({ deliveryZoneId: String(zoneId), saleIds: [] })
    const duplicate = await previewRequest([saleId, saleId])

    for (const response of [missing, duplicate]) {
      expect(response.status).to.equal(400)
      expect(response.body.code).to.equal('INVALID_ROUTE_INPUT')
    }
  })

  it('S-20: revalidates selected sales and does not call providers for ineligible state', async () => {
    const matrix = sinon.stub(routeMatrixProvider, 'computeMatrix')
    const finalRoute = sinon.stub(routeMatrixProvider, 'computeRoute')
    const clientId = await createEligibleClient('Invalid sale customer', -34.61, -58.41)
    const saleId = await createSale(clientId)
    await SaleModel.updateOne({ _id: saleId }, { $set: { 'delivery.status': 'DELIVERED', 'delivery.deliveredAt': new Date() }, $unset: { 'delivery.serviceDate': 1 } })
    await configureRouting()

    const response = await previewRequest([saleId])

    expect(response.status).to.equal(422)
    expect(response.body.code).to.equal('NO_ELIGIBLE_ORDERS')
    expect(matrix.called).to.equal(false)
    expect(finalRoute.called).to.equal(false)
  })

  it('S-26: rejects missing routing configuration or depot coordinates; vehicle supplies fuel', async () => {
    const clientId = await createEligibleClient('Config customer', -34.61, -58.41)
    const saleId = await createSale(clientId)
    const missingConfig = await previewRequest([saleId])
    await configureRouting()
    await RoutingConfigModel.updateOne({ key: 'deposito_1' }, { $set: { fuelConsumptionLitersPer100Km: 8.5 }, $unset: { 'depot.latitude': 1 } })
    const missingDepot = await previewRequest([saleId])

    for (const response of [missingConfig, missingDepot]) {
      expect(response.status).to.equal(422)
      expect(response.body.code).to.equal('INVALID_CONFIGURATION')
    }
  })

  it('S-02/TC-011: groups sales by client and returns an unpersisted complete preview with fuel', async () => {
    const firstClientId = await createEligibleClient('First customer', -34.61, -58.41)
    const secondClientId = await createEligibleClient('Second customer', -34.62, -58.42)
    const firstSaleId = await createSale(firstClientId)
    const secondSaleId = await createSale(firstClientId)
    const thirdSaleId = await createSale(secondClientId)
    await configureRouting()
    sinon.stub(routeMatrixProvider, 'computeMatrix').callsFake(async ({ origins }) => ({
      segments: origins.flatMap((from, fromIndex) => origins.filter((to) => to.id !== from.id).map((to, toIndex) => ({ fromId: from.id, toId: to.id, distanceMeters: (fromIndex + toIndex + 1) * 1000, durationSeconds: (fromIndex + toIndex + 1) * 60 })))
    }))
    sinon.stub(routeMatrixProvider, 'computeRoute').resolves({ encodedPolyline: 'encoded-route', distanceMeters: 12000, durationSeconds: 900 })
    const salesBefore = await SaleModel.find({}).sort({ _id: 1 }).lean()
    const clientsBefore = await ClientModel.find({}).sort({ _id: 1 }).lean()

    const response = await previewRequest([firstSaleId, secondSaleId, thirdSaleId])

    expect(response.status).to.equal(200)
    expect(response.body.route.depot.id).to.equal('deposito_1')
    expect(response.body.route.encodedPolyline).to.equal('encoded-route')
    expect(response.body.route.stops).to.have.length(2)
    expect(response.body.route.stops.find((stop: { clientId: string }) => stop.clientId === String(firstClientId)).saleIds).to.deep.equal([String(firstSaleId), String(secondSaleId)])
    expect(response.body.metrics).to.deep.equal({ distanceMeters: 12000, durationSeconds: 900, stopCount: 2, fuelLiters: 1.02, availability: 'CALCULATED' })
    expect(response.body.warnings).to.deep.equal(['TIME_WINDOWS_NOT_CONSIDERED'])
    expect(response.body.factorsConsidered).to.deep.equal(['DISTANCE', 'DURATION', 'FUEL_CONSUMPTION'])
    expect(response.body.algorithmVersion).to.equal('nearest-neighbor-2opt-v1')
    expect(response.body.routingConfigRevision).to.equal(3)
    expect(response.body.ruleVersion).to.equal('candidate-eligibility-v1')
    expect(await SaleModel.find({}).sort({ _id: 1 }).lean()).to.deep.equal(salesBefore)
    expect(await ClientModel.find({}).sort({ _id: 1 }).lean()).to.deep.equal(clientsBefore)
    expect(await RoutePlanModel.countDocuments({})).to.equal(0)
  })

  it('S-22/TC-032: returns typed provider failure without a partial preview', async () => {
    const clientId = await createEligibleClient('Provider customer', -34.61, -58.41)
    const saleId = await createSale(clientId)
    await configureRouting()
    sinon.stub(routeMatrixProvider, 'computeMatrix').rejects(new routeMatrixProvider.RouteProviderError('ROUTING_PROVIDER_UNAVAILABLE', 'Provider unavailable'))

    const response = await previewRequest([saleId])

    expect(response.status).to.equal(503)
    expect(response.body.code).to.equal('ROUTING_PROVIDER_UNAVAILABLE')
    expect(response.body.route).to.equal(undefined)
  })

  it('S-22/TC-021: provider and preview failure logs carry a bounded diagnostic without sensitive payload fields', async () => {
    const clientId = await createEligibleClient('Diagnostic customer', -34.61, -58.41)
    const saleId = await createSale(clientId)
    await configureRouting()
    sinon.stub(routeMatrixProvider, 'computeMatrix').rejects(new routeMatrixProvider.RouteProviderError('ROUTE_MATRIX_INCOMPLETE', 'Google Routes matrix response is incomplete', {
      reason: 'INCOMPLETE_COVERAGE',
      expectedElements: 2,
      receivedElements: 1,
      validRoutes: 1,
      conditionCounts: { ROUTE_EXISTS: 1 },
      statusCodeCounts: { MISSING: 1 }
    }))
    const log = sinon.stub(console, 'log')

    try {
      const response = await previewRequest([saleId])

      expect(response.status).to.equal(422)
      expect(response.body.code).to.equal('ROUTE_MATRIX_INCOMPLETE')
      const output = log.getCalls().map((call) => call.args.join(' ')).join('\n')
      expect(output).to.contain('route_plan_provider_failed')
      expect(output).to.contain('route_plan_preview_failed')
      expect(output).to.contain('"expectedElements":2')
      expect(output).to.contain('"receivedElements":1')
      expect(output).to.contain('"validRoutes":1')
      expect(output).to.contain('"ROUTE_EXISTS":1')
      expect(output).to.not.contain('Diagnostic customer')
      expect(output).to.not.contain('-34.61')
      expect(output).to.not.contain('-58.41')
    } finally {
      log.restore()
    }
  })

  it('S-21/TC-014: rejects a selection that exceeds the configured stop limit before any provider call', async () => {
    const firstClientId = await createEligibleClient('Limit customer one', -34.61, -58.41)
    const secondClientId = await createEligibleClient('Limit customer two', -34.62, -58.42)
    const firstSaleId = await createSale(firstClientId)
    const secondSaleId = await createSale(secondClientId)
    await configureRouting()
    await setMaxStops(1)
    const matrix = sinon.stub(routeMatrixProvider, 'computeMatrix')
    const finalRoute = sinon.stub(routeMatrixProvider, 'computeRoute')

    const response = await previewRequest([firstSaleId, secondSaleId])

    expect(response.status).to.equal(422)
    expect(response.body.code).to.equal('ROUTE_TECHNICAL_LIMIT_EXCEEDED')
    expect(matrix.called).to.equal(false)
    expect(finalRoute.called).to.equal(false)
    expect(await RoutePlanModel.countDocuments({})).to.equal(0)
  })

  it('S-26: requires authentication for routing configuration reads and updates', async () => {
    const payload = { depot: { name: 'Deposito 1', latitude: -34.6, longitude: -58.4 }, routeMode: 'google-routes' }
    const unauthGet = await request(app).get('/routePlan/config')
    const forbiddenGet = await request(app).get('/routePlan/config').set('Authorization', `Bearer ${authorizedToken}`)
    const unauthPatch = await request(app).patch('/routePlan/config').send(payload)
    const forbiddenPatch = await request(app).patch('/routePlan/config').set('Authorization', `Bearer ${authorizedToken}`).send(payload)

    expect(unauthGet.status).to.equal(401)
    expect(unauthGet.body.code).to.equal('AUTHENTICATION_INVALID')
    expect(forbiddenGet.status).to.equal(404)
    expect(forbiddenGet.body.code).to.equal('INVALID_CONFIGURATION')
    expect(unauthPatch.status).to.equal(401)
    expect(unauthPatch.body.code).to.equal('AUTHENTICATION_INVALID')
    expect(forbiddenPatch.status).to.equal(200)
  })

  it('S-26: configures deposito_1, bumps the revision and records the authenticated actor', async () => {
    await configureRouting()

    const patch = await request(app)
      .patch('/routePlan/config')
      .set('Authorization', `Bearer ${configAdminToken}`)
      .send({
        depot: { name: 'Deposito 1', latitude: -34.6, longitude: -58.4 },
        fuelConsumptionLitersPer100Km: 9.2,
        routeMode: 'google-routes',
        maxStops: 12
      })

    expect(patch.status).to.equal(200)
    expect(patch.body.revision).to.equal(4)
    expect(patch.body.provider).to.equal('google-routes')
    expect(patch.body.updatedBy).to.equal(configAdminUserId)
    expect(patch.body.maxStops).to.equal(12)
    expect(patch.body.fuelConsumptionLitersPer100Km).to.equal(9.2)
    expect(patch.body.enabled).to.equal(true)

    const read = await request(app).get('/routePlan/config').set('Authorization', `Bearer ${configAdminToken}`)

    expect(read.status).to.equal(200)
    expect(read.body.revision).to.equal(4)
    expect(read.body.updatedBy).to.equal(configAdminUserId)
  })

  it('S-26: rejects invalid depot coordinates and keeps preview generation disabled', async () => {
    const outOfRange = await request(app)
      .patch('/routePlan/config')
      .set('Authorization', `Bearer ${configAdminToken}`)
      .send({ depot: { name: 'Deposito 1', latitude: -34.6, longitude: 200 }, routeMode: 'google-routes' })
    const missingAddress = await request(app)
      .patch('/routePlan/config')
      .set('Authorization', `Bearer ${configAdminToken}`)
      .send({ depot: { name: '   ', latitude: -34.6, longitude: -58.4 }, routeMode: 'google-routes' })
    const unknownMode = await request(app)
      .patch('/routePlan/config')
      .set('Authorization', `Bearer ${configAdminToken}`)
      .send({ depot: { name: 'Deposito 1', latitude: -34.6, longitude: -58.4 }, routeMode: 'unknown-mode' })

    for (const response of [outOfRange, missingAddress, unknownMode]) {
      expect(response.status).to.equal(400)
      expect(response.body.code).to.equal('INVALID_CONFIGURATION')
    }

    const read = await request(app).get('/routePlan/config').set('Authorization', `Bearer ${configAdminToken}`)
    expect(read.status).to.equal(404)

    const clientId = await createEligibleClient('Unconfigured customer', -34.61, -58.41)
    const saleId = await createSale(clientId)
    const previewResponse = await previewRequest([saleId])

    expect(previewResponse.status).to.equal(422)
    expect(previewResponse.body.code).to.equal('INVALID_CONFIGURATION')
  })

  it('TC-021: route preview logs exclude client addresses, coordinates, and request bodies', async () => {
    const clientId = await createEligibleClient('Sensitive customer', -34.61, -58.41)
    const saleId = await createSale(clientId)
    await configureRouting()
    sinon.stub(routeMatrixProvider, 'computeMatrix').callsFake(async ({ origins }) => ({
      segments: origins.flatMap((from, fromIndex) => origins.filter((to) => to.id !== from.id).map((to, toIndex) => ({ fromId: from.id, toId: to.id, distanceMeters: (fromIndex + toIndex + 1) * 1000, durationSeconds: (fromIndex + toIndex + 1) * 60 })))
    }))
    sinon.stub(routeMatrixProvider, 'computeRoute').resolves({ encodedPolyline: 'encoded-route', distanceMeters: 12000, durationSeconds: 900 })
    const log = sinon.stub(console, 'log')

    try {
      const response = await previewRequest([saleId])

      expect(response.status).to.equal(200)
      const output = log.getCalls().map((call) => call.args.join(' ')).join('\n')
      expect(output).to.contain('route_plan_preview_completed')
      expect(output).to.not.contain('Sensitive customer')
      expect(output).to.not.contain('Sensitive customer address')
      expect(output).to.not.contain('-34.61')
      expect(output).to.not.contain('-58.41')
    } finally {
      log.restore()
    }
  })
})
