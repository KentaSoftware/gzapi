import { expect } from 'chai'
import mongoose, { Types } from 'mongoose'
import request from 'supertest'

import ClientModel from '../src/models/client'
import RoleModel from '../src/models/role'
import SaleModel from '../src/models/sale'
import UserModel from '../src/models/user'
import { generateToken } from '../src/utils/jwt.handle'

const TEST_DB_URI = 'mongodb://localhost:27017/gzapi_route_plan_candidates_test'
const SERVICE_DATE = '2026-10-05'
const SERVICE_DAY_START = new Date('2026-10-05T03:00:00.000Z')

describe('Route plan candidate query', () => {
  let app: Awaited<ReturnType<typeof import('../src/app').createApp>>
  let authorizedToken: string
  let unauthorizedToken: string
  let userId: Types.ObjectId

  const createSale = async (id: Types.ObjectId, clientId?: Types.ObjectId, serviceDate = SERVICE_DAY_START): Promise<void> => {
    await SaleModel.create({
      _id: id,
      estado: 'CREATED',
      total: 100,
      user: userId,
      cliente: 'Delivery customer',
      idCliente: clientId,
      delivery: { status: 'PENDING', serviceDate }
    })
  }

  before(async () => {
    await mongoose.connect(TEST_DB_URI)
    const { createApp } = await import('../src/app')
    app = await createApp()
  })

  after(async () => {
    const dbName = mongoose.connection.db?.databaseName
    if (dbName?.endsWith('_test') === true) await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
  })

  beforeEach(async () => {
    await SaleModel.deleteMany({})
    await ClientModel.deleteMany({})
    await UserModel.deleteMany({})
    await RoleModel.deleteMany({})

    const authorizedRole = await RoleModel.create({ name: 'Route planner', permissions: ['read_route_plan'] })
    const unauthorizedRole = await RoleModel.create({ name: 'Sales reader', permissions: ['read_sale'] })
    const authorizedUser = await UserModel.create({ nickname: 'route-planner', password: 'not-a-real-password', role: authorizedRole._id })
    const unauthorizedUser = await UserModel.create({ nickname: 'sales-reader', password: 'not-a-real-password', role: unauthorizedRole._id })

    userId = authorizedUser._id
    authorizedToken = await generateToken(authorizedUser)
    unauthorizedToken = await generateToken(unauthorizedUser)
  })

  it('S-28/TC-017: rejects a candidate query without authentication before reading sales', async () => {
    const response = await request(app).get(`/routePlan/candidates?serviceDate=${SERVICE_DATE}&deliveryZoneId=507f1f77bcf86cd799439011`)

    expect(response.status).to.equal(401)
    expect(response.body.code).to.equal('AUTHENTICATION_INVALID')
  })

  it('S-29/TC-017/TC-020: allows an authenticated candidate query without route permissions', async () => {
    const response = await request(app)
      .get(`/routePlan/candidates?serviceDate=${SERVICE_DATE}&deliveryZoneId=507f1f77bcf86cd799439011`)
      .set('Authorization', `Bearer ${unauthorizedToken}`)

    expect(response.status).to.equal(200)
    expect(response.body).to.deep.equal({ eligible: [], blocked: [], ruleVersion: 'candidate-eligibility-v1' })
  })

  it('S-01: validates required candidate query values', async () => {
    const missingDate = await request(app)
      .get('/routePlan/candidates?deliveryZoneId=507f1f77bcf86cd799439011')
      .set('Authorization', `Bearer ${authorizedToken}`)
    const malformedDate = await request(app)
      .get('/routePlan/candidates?serviceDate=2026-02-30&deliveryZoneId=507f1f77bcf86cd799439011')
      .set('Authorization', `Bearer ${authorizedToken}`)
    const malformedZone = await request(app)
      .get(`/routePlan/candidates?serviceDate=${SERVICE_DATE}&deliveryZoneId=not-an-object-id`)
      .set('Authorization', `Bearer ${authorizedToken}`)

    for (const response of [missingDate, malformedDate, malformedZone]) {
      expect(response.status).to.equal(400)
      expect(response.body.code).to.equal('INVALID_ROUTE_INPUT')
    }
  })

  it('S-01: classifies every pending sale exactly once in stable sale identifier order without mutations', async () => {
    const requestedZoneId = new Types.ObjectId('507f1f77bcf86cd799439011')
    const otherZoneId = new Types.ObjectId('507f1f77bcf86cd799439012')
    const ids = [
      new Types.ObjectId('507f191e810c19729de86011'),
      new Types.ObjectId('507f191e810c19729de86012'),
      new Types.ObjectId('507f191e810c19729de86013'),
      new Types.ObjectId('507f191e810c19729de86014'),
      new Types.ObjectId('507f191e810c19729de86015'),
      new Types.ObjectId('507f191e810c19729de86016')
    ]
    const inactiveClient = await ClientModel.create({ nombreCompleto: 'Inactive', isActive: false, deliveryZoneId: requestedZoneId })
    const mismatchClient = await ClientModel.create({ nombreCompleto: 'Wrong zone', isActive: true, deliveryZoneId: otherZoneId })
    const missingLocationClient = await ClientModel.create({ nombreCompleto: 'Missing location', isActive: true, deliveryZoneId: requestedZoneId })
    const unconfirmedClient = await ClientModel.create({ nombreCompleto: 'Unconfirmed', isActive: true, deliveryZoneId: requestedZoneId, address: 'Unconfirmed address', lat: -34.6, lng: -58.4, geocoding: { status: 'PENDING', source: 'MANUAL', validatedBy: userId } })
    const eligibleClient = await ClientModel.create({ nombreCompleto: 'Eligible', isActive: true, deliveryZoneId: requestedZoneId, address: 'Eligible address', lat: -34.61, lng: -58.41, geocoding: { status: 'CONFIRMED', source: 'GEOCODED', validatedAt: new Date(), validatedBy: userId } })

    await SaleModel.collection.insertOne({ _id: ids[0], estado: 'CREATED', total: 100, user: userId, cliente: 'Unknown', delivery: { status: 'PENDING', serviceDate: SERVICE_DAY_START } })
    await createSale(ids[1], inactiveClient._id)
    await createSale(ids[2], mismatchClient._id)
    await createSale(ids[3], missingLocationClient._id)
    await createSale(ids[4], unconfirmedClient._id)
    await createSale(ids[5], eligibleClient._id)
    await SaleModel.collection.insertOne({ _id: new Types.ObjectId('507f191e810c19729de86017'), estado: 'CREATED', total: 100, user: userId, delivery: { status: 'PENDING', serviceDate: new Date('2026-10-06T03:00:00.000Z') } })
    await SaleModel.collection.insertOne({ _id: new Types.ObjectId('507f191e810c19729de86018'), estado: 'CREATED', total: 100, user: userId })

    const salesBefore = await SaleModel.find({}).sort({ _id: 1 }).lean()
    const clientsBefore = await ClientModel.find({}).sort({ _id: 1 }).lean()

    const response = await request(app)
      .get(`/routePlan/candidates?serviceDate=${SERVICE_DATE}&deliveryZoneId=${String(requestedZoneId)}`)
      .set('Authorization', `Bearer ${authorizedToken}`)

    expect(response.status).to.equal(200)
    expect(response.body.ruleVersion).to.equal('candidate-eligibility-v1')
    expect(response.body.blocked.map((candidate: { saleId: string }) => candidate.saleId)).to.deep.equal(ids.slice(0, 5).map(String))
    expect(response.body.blocked.map((candidate: { reasons: string[] }) => candidate.reasons)).to.deep.equal([
      ['INVALID_CLIENT_REFERENCE'],
      ['CLIENT_INACTIVE'],
      ['CLIENT_ZONE_MISMATCH'],
      ['CLIENT_LOCATION_MISSING'],
      ['CLIENT_LOCATION_UNCONFIRMED']
    ])
    expect(response.body.eligible).to.deep.equal([{
      saleId: String(ids[5]),
      clientId: String(eligibleClient._id),
      displayName: 'Eligible',
      addressSummary: 'Eligible address',
      latitude: -34.61,
      longitude: -58.41
    }])
    expect(await SaleModel.find({}).sort({ _id: 1 }).lean()).to.deep.equal(salesBefore)
    expect(await ClientModel.find({}).sort({ _id: 1 }).lean()).to.deep.equal(clientsBefore)
  })

  it('S-10: returns explicit empty candidates when no pending sale falls in the requested civil date', async () => {
    const response = await request(app)
      .get(`/routePlan/candidates?serviceDate=${SERVICE_DATE}&deliveryZoneId=507f1f77bcf86cd799439011`)
      .set('Authorization', `Bearer ${authorizedToken}`)

    expect(response.status).to.equal(200)
    expect(response.body).to.deep.equal({ eligible: [], blocked: [], ruleVersion: 'candidate-eligibility-v1' })
  })

  it('S-11: excludes historical sales without delivery and never assigns a delivery default', async () => {
    const requestedZoneId = new Types.ObjectId('507f1f77bcf86cd799439011')
    const eligibleClient = await ClientModel.create({
      nombreCompleto: 'Historical customer',
      address: 'Historical address',
      lat: -34.61,
      lng: -58.41,
      isActive: true,
      deliveryZoneId: requestedZoneId,
      geocoding: { status: 'CONFIRMED', source: 'GEOCODED', validatedAt: new Date(), validatedBy: userId }
    })
    const historicalSaleId = new Types.ObjectId('507f191e810c19729de86021')
    const incompleteDeliverySaleId = new Types.ObjectId('507f191e810c19729de86022')
    await SaleModel.collection.insertOne({ _id: historicalSaleId, estado: 'CREATED', total: 100, user: userId, cliente: 'Historical', idCliente: eligibleClient._id })
    await SaleModel.collection.insertOne({ _id: incompleteDeliverySaleId, estado: 'CREATED', total: 100, user: userId, cliente: 'Incomplete', idCliente: eligibleClient._id, delivery: { status: 'PENDING' } })

    const response = await request(app)
      .get(`/routePlan/candidates?serviceDate=${SERVICE_DATE}&deliveryZoneId=${String(requestedZoneId)}`)
      .set('Authorization', `Bearer ${authorizedToken}`)

    expect(response.status).to.equal(200)
    expect(response.body.eligible).to.deep.equal([])
    expect(response.body.blocked).to.deep.equal([])

    const historicalSale = await SaleModel.findById(historicalSaleId).lean()
    expect(historicalSale?.delivery).to.equal(undefined)
    const incompleteDeliverySale = await SaleModel.findById(incompleteDeliverySaleId).lean()
    expect(incompleteDeliverySale?.delivery?.status).to.equal('PENDING')
    expect(incompleteDeliverySale?.delivery?.serviceDate).to.equal(undefined)
  })
})
