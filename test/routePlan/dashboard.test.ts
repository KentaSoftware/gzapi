import { expect } from 'chai'
import mongoose, { Types } from 'mongoose'
import request from 'supertest'

import ClientModel from '../../src/models/client'
import DeliveryZoneModel from '../../src/models/deliveryZone'
import RoleModel from '../../src/models/role'
import RoutePlanModel from '../../src/models/routePlan'
import SaleModel from '../../src/models/sale'
import UserModel from '../../src/models/user'
import { generateToken } from '../../src/utils/jwt.handle'

const TEST_DB_URI = 'mongodb://localhost:27017/gzapi_route_plan_dashboard_test'
const SERVICE_DATE = '2026-10-12'
const SERVICE_DAY_START = new Date('2026-10-12T03:00:00.000Z')

describe('Route dashboard aggregation', () => {
  let app: Awaited<ReturnType<typeof import('../../src/app').createApp>>
  let token: string
  let userId: Types.ObjectId
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
      SaleModel.deleteMany({}),
      UserModel.deleteMany({})
    ])
    const role = await RoleModel.create({ name: 'Route reader', permissions: ['read_route_plan'] })
    const user = await UserModel.create({ nickname: 'route-reader', password: 'not-a-real-password', role: role._id })
    userId = user._id
    token = await generateToken(user)
    const zone = await DeliveryZoneModel.create({ code: 'NORTE', normalizedName: 'norte', name: 'Norte', active: true })
    zoneId = zone._id
  })

  it('S-02: requires authentication and read_route_plan for the dashboard', async () => {
    const unauthenticated = await request(app).get(`/routePlan/dashboard?serviceDate=${SERVICE_DATE}&zoneCode=NORTE`)
    expect(unauthenticated.status).to.equal(401)

    const response = await request(app)
      .get(`/routePlan/dashboard?serviceDate=${SERVICE_DATE}&zoneCode=NORTE`)
      .set('Authorization', `Bearer ${token}`)
    expect(response.status).to.equal(200)
  })

  it('S-03: returns stable KPIs and route cards from bounded snapshot reads', async () => {
    await RoutePlanModel.create({
      snapshotVersion: 1,
      planningDate: SERVICE_DAY_START,
      zoneSnapshot: { code: 'NORTE', normalizedName: 'norte', name: 'Norte' },
      selectedSaleIds: ['sale-1'],
      depot: { name: 'Deposito 1', latitude: -34.6, longitude: -58.4 },
      stops: [{ clientId: 'client-1', saleIds: ['sale-1'], sequence: 1, latitude: -34.61, longitude: -58.41 }],
      segments: [],
      metrics: { distanceMeters: 12500, durationSeconds: 900, stopCount: 1, fuelLiters: 1.25, availability: 'CALCULATED' },
      algorithm: { name: 'heuristic', version: '1', provider: 'internal' },
      routingConfigRevision: 1,
      ruleVersion: 'candidate-eligibility-v1',
      encodedPolyline: 'encoded-route',
      warnings: [],
      assignments: { driverId: 'driver-1', vehicleId: 'vehicle-1' },
      fuelAssumptions: { availability: 'CALCULATED', consumptionLitersPer100Km: 10, distanceKm: 12.5, vehicleCode: 'AA123AA', source: 'vehicle', calculatedAt: new Date() },
      scheduleAssumptions: { calculatedAt: new Date(), timezone: 'America/Argentina/Buenos_Aires', source: 'route-schedule' },
      stopEstimates: [{ sequence: 1, arrival: new Date('2026-10-12T03:15:00.000Z'), cumulativeDurationSeconds: 900, calculatedAt: new Date(), timezone: 'America/Argentina/Buenos_Aires', availability: 'CALCULATED' }],
      audit: { createdBy: String(userId), createdAt: new Date() }
    })

    const response = await request(app)
      .get(`/routePlan/dashboard?serviceDate=${SERVICE_DATE}&zoneCode=NORTE`)
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).to.equal(200)
    expect(response.body.kpis).to.deep.equal({ activeRoutes: 1, pendingOrders: 0, totalDistanceMeters: 12500, estimatedFuelLiters: 1.25 })
    expect(response.body.routes).to.have.length(1)
    expect(response.body.routes[0]).to.include({ status: 'PENDING', clientCount: 1 })
    expect(response.body.routes[0].metrics).to.deep.equal({ distanceMeters: 12500, durationSeconds: 900, fuelLiters: 1.25 })
    expect(response.body.routes[0]).to.include.keys(['depot', 'stops', 'metricAvailability', 'fuelAssumptions', 'scheduleAssumptions', 'stopEstimates'])
    expect(response.body.routes[0].depot).to.deep.equal({ name: 'Deposito 1', latitude: -34.6, longitude: -58.4 })
    expect(response.body.routes[0].stops[0]).to.deep.equal({ clientId: 'client-1', saleIds: ['sale-1'], sequence: 1, latitude: -34.61, longitude: -58.41 })
    expect(response.body.routes[0].assignments).to.deep.equal({ driverId: 'driver-1', vehicleId: 'vehicle-1' })
  })

  it('S-10: validates the civil date, zone code and optional operational status', async () => {
    const invalidDate = await request(app)
      .get('/routePlan/dashboard?serviceDate=2026-02-30&zoneCode=NORTE')
      .set('Authorization', `Bearer ${token}`)
    const invalidStatus = await request(app)
      .get(`/routePlan/dashboard?serviceDate=${SERVICE_DATE}&zoneCode=NORTE&status=UNKNOWN`)
      .set('Authorization', `Bearer ${token}`)

    expect(invalidDate.status).to.equal(400)
    expect(invalidDate.body.code).to.equal('INVALID_ROUTE_INPUT')
    expect(invalidStatus.status).to.equal(400)
    expect(invalidStatus.body.code).to.equal('INVALID_ROUTE_INPUT')
  })

  it('S-22: keeps eligible and blocked candidates visible with stable causes', async () => {
    const eligibleClient = await ClientModel.create({
      nombreCompleto: 'Eligible',
      address: 'Eligible address',
      lat: -34.61,
      lng: -58.41,
      isActive: true,
      deliveryZoneId: zoneId,
      geocoding: { status: 'CONFIRMED', source: 'GEOCODED', validatedAt: new Date(), validatedBy: userId }
    })
    const blockedClient = await ClientModel.create({ nombreCompleto: 'Blocked', isActive: true, deliveryZoneId: zoneId })
    await SaleModel.create([{ estado: 'CREATED', total: 100, user: userId, cliente: 'Eligible', idCliente: eligibleClient._id, delivery: { status: 'PENDING', serviceDate: SERVICE_DAY_START } }, { estado: 'CREATED', total: 100, user: userId, cliente: 'Blocked', idCliente: blockedClient._id, delivery: { status: 'PENDING', serviceDate: SERVICE_DAY_START } }])

    const response = await request(app)
      .get(`/routePlan/dashboard?serviceDate=${SERVICE_DATE}&zoneCode=NORTE`)
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).to.equal(200)
    expect(response.body.candidates.eligible).to.have.length(1)
    expect(response.body.candidates.blocked[0].reasons).to.deep.equal(['CLIENT_LOCATION_MISSING'])
    expect(response.body.kpis.pendingOrders).to.equal(1)
  })

  it('S-23: reports unavailable aggregate metrics without fabricating route values', async () => {
    const response = await request(app)
      .get(`/routePlan/dashboard?serviceDate=${SERVICE_DATE}&zoneCode=NORTE`)
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).to.equal(200)
    expect(response.body.kpis).to.deep.equal({ activeRoutes: 0, pendingOrders: 0, totalDistanceMeters: null, estimatedFuelLiters: null })
    expect(response.body.warnings).to.deep.equal(['NO_DASHBOARD_DATA'])
  })

  it('S-24: keeps selected-route detail fields optional for legacy snapshots', async () => {
    await RoutePlanModel.create({
      snapshotVersion: 1,
      planningDate: SERVICE_DAY_START,
      zoneSnapshot: { code: 'NORTE', normalizedName: 'norte', name: 'Norte' },
      selectedSaleIds: ['legacy-sale'],
      depot: { name: 'Deposito 1', latitude: -34.6, longitude: -58.4 },
      stops: [{ clientId: 'legacy-client', saleIds: ['legacy-sale'], sequence: 1, latitude: -34.61, longitude: -58.41 }],
      segments: [],
      metrics: { distanceMeters: 100, durationSeconds: 10, stopCount: 1 },
      algorithm: { name: 'heuristic', version: '1', provider: 'internal' },
      routingConfigRevision: 1,
      ruleVersion: 'candidate-eligibility-v1',
      encodedPolyline: 'legacy-route',
      warnings: [],
      audit: { createdBy: String(userId), createdAt: new Date() }
    })

    const response = await request(app)
      .get(`/routePlan/dashboard?serviceDate=${SERVICE_DATE}&zoneCode=NORTE`)
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).to.equal(200)
    expect(response.body.routes[0]).to.include.keys(['depot', 'stops'])
    expect(response.body.routes[0]).not.to.have.any.keys(['fuelAssumptions', 'scheduleAssumptions', 'stopEstimates', 'saleReferences'])
  })

  it('NFR-010: truncates oversized route detail without changing the bounded dashboard result', async () => {
    await RoutePlanModel.create({
      snapshotVersion: 1,
      planningDate: SERVICE_DAY_START,
      zoneSnapshot: { code: 'NORTE', normalizedName: 'norte', name: 'Norte' },
      selectedSaleIds: ['bounded-sale'],
      depot: { name: 'Deposito 1', latitude: -34.6, longitude: -58.4 },
      stops: Array.from({ length: 51 }, (_value, index) => ({ clientId: `client-${index}`, saleIds: [`sale-${index}`], sequence: index + 1, latitude: -34.61, longitude: -58.41 })),
      segments: [],
      metrics: { distanceMeters: 100, durationSeconds: 10, stopCount: 51 },
      algorithm: { name: 'heuristic', version: '1', provider: 'internal' },
      routingConfigRevision: 1,
      ruleVersion: 'candidate-eligibility-v1',
      encodedPolyline: 'bounded-route',
      warnings: [],
      audit: { createdBy: String(userId), createdAt: new Date() }
    })

    const response = await request(app)
      .get(`/routePlan/dashboard?serviceDate=${SERVICE_DATE}&zoneCode=NORTE`)
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).to.equal(200)
    expect(response.body.routes[0]).not.to.have.property('stops')
    expect(response.body.warnings).to.include('DASHBOARD_ROUTE_DETAIL_LIMIT_REACHED')
  })
})
