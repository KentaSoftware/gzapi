import { randomBytes } from 'crypto'
import { expect } from 'chai'
import express from 'express'
import mongoose, { Types } from 'mongoose'
import { MongoClient } from 'mongodb'
import request from 'supertest'
import ProductModel from '../../src/models/product'
import UserModel from '../../src/models/user'
import RoutePlanModel from '../../src/models/routePlan'
import RoutePlanOperationalModel from '../../src/models/routePlanOperational'
import RouteSimulationModel from '../../src/models/routeSimulation'
import { createRealRouteScenario } from '../../src/services/routeSimulation'
import { createSimulationRouter } from '../../src/routes/simulation'

const enabled = process.env.RUN_REAL_ROUTE_SIMULATION_MONGO === '1'

// Production service models are bound to Mongoose's default connection. Until
// they can be bound to a verified independent connection, no writes are safe.
const requireIsolatedServiceModels = (): void => {
  throw new Error('Real Mongo test disabled: service models lack an independently locked connection')
}

describe('real route simulation against isolated local MongoDB', function () {
  if (!enabled) {
    it.skip('requires explicit RUN_REAL_ROUTE_SIMULATION_MONGO=1', () => {})
    return
  }

  const dbName = `gzapi_route_sim_int_${randomBytes(16).toString('hex')}`
  const uri = `mongodb://127.0.0.1:27017/${dbName}?directConnection=true&serverSelectionTimeoutMS=3000`
  const driverId = new Types.ObjectId()
  const otherDriverId = new Types.ObjectId()
  const routeId = new Types.ObjectId()
  const missingFuelId = new Types.ObjectId()
  const productId = new Types.ObjectId()
  const operationalId = new Types.ObjectId()
  let owned = false
  let connected = false
  let connectionOpenedHere = false
  let scenarioId: Types.ObjectId | undefined

  before(async function () {
    requireIsolatedServiceModels()
    if (mongoose.connection.readyState !== 0) throw new Error('Refusing an existing Mongoose connection')
    const client = new MongoClient(uri)
    try {
      await client.connect()
      const result = await client.db('admin').command({ listDatabases: 1, nameOnly: true, authorizedDatabases: false, filter: { name: dbName } })
      if (result.ok !== 1 || !Array.isArray(result.databases) || result.databases.length !== 0) throw new Error('Cannot prove candidate database is absent')
      console.log(`    ownership: ${dbName} absent on 127.0.0.1:27017 before writes`)
      owned = true
    } finally {
      await client.close()
    }
    connectionOpenedHere = true
    await mongoose.connect(uri, { autoIndex: false, autoCreate: false })
    if (mongoose.connection.name !== dbName || mongoose.connection.host !== '127.0.0.1') throw new Error('Unexpected database connection')
    connected = true
  })

  after(async function () {
    if (!connected || !owned) {
      if (connectionOpenedHere && mongoose.connection.readyState !== 0) await mongoose.disconnect()
      return
    }
    try {
      if (mongoose.connection.name !== dbName || mongoose.connection.host !== '127.0.0.1') throw new Error('Refusing cleanup on unexpected database')
      const counts = await Promise.all([
        RouteSimulationModel.deleteMany({ _id: { $in: scenarioId === undefined ? [] : [scenarioId] } }),
        RoutePlanOperationalModel.deleteMany({ _id: operationalId }),
        RoutePlanModel.deleteMany({ _id: { $in: [routeId, missingFuelId] } }),
        ProductModel.deleteMany({ _id: productId }),
        UserModel.deleteMany({ _id: { $in: [driverId, otherDriverId] } })
      ])
      console.log(`    cleanup: scenarios=${counts[0].deletedCount} assignments=${counts[1].deletedCount} routes=${counts[2].deletedCount} products=${counts[3].deletedCount} users=${counts[4].deletedCount}; database retained`)
    } finally {
      await mongoose.disconnect()
    }
  })

  it('saves and reads frozen results, enforces reassignment, and preserves source records', async function () {
    const now = new Date('2026-01-01T12:00:00.000Z')
    await UserModel.create([{ _id: driverId, nickname: 'fixture-driver', password: 'fixture-only' }, { _id: otherDriverId, nickname: 'fixture-other-driver', password: 'fixture-only' }])
    await ProductModel.create({ _id: productId, descripcion: 'Fixture product', stock: 8, precioUnitario: 12.5, categoria: new Types.ObjectId(), marca: new Types.ObjectId(), proveedor: new Types.ObjectId() })
    const route = {
      snapshotVersion: 1,
      planningDate: now,
      zoneSnapshot: { code: 'FIXTURE', normalizedName: 'fixture', name: 'Fixture' },
      selectedSaleIds: ['fixture-sale'],
      depot: { name: 'Fixture depot', latitude: 0, longitude: 0 },
      stops: [{ clientId: 'fixture-client', saleIds: ['fixture-sale'], sequence: 1, latitude: 0, longitude: 0 }],
      segments: [],
      metrics: { distanceMeters: 1000, durationSeconds: 5400, stopCount: 1, fuelLiters: 2 },
      algorithm: { name: 'fixture', version: '1', provider: 'fixture' },
      routingConfigRevision: 1,
      ruleVersion: 'fixture',
      encodedPolyline: 'fixture',
      warnings: [],
      audit: { createdBy: String(driverId), createdAt: now },
      assignments: { driverId: String(driverId) }
    }
    await RoutePlanModel.create([{ ...route, _id: routeId }, { ...route, _id: missingFuelId, metrics: { ...route.metrics, fuelLiters: null } }])
    await RoutePlanOperationalModel.create({ _id: operationalId, snapshotId: String(routeId), status: 'PENDING', sourceDeliveryVersion: 0, assignments: { driverId: String(driverId) }, history: [], version: 1 })
    const beforeRoute = await RoutePlanModel.findById(routeId).lean()
    const beforeProduct = await ProductModel.findById(productId).lean()
    const parameters = { fuelPricePerLiter: 10, hourlyRate: 20, generalCosts: 5, includeSurplus: true }
    const input = { routeId: String(routeId), parameters, products: [{ id: String(productId), quantity: 3 }] }
    const scope = { kind: 'driver' as const, userId: String(driverId) }
    const saved = await createRealRouteScenario(input, scope)
    scenarioId = new Types.ObjectId(saved.id)
    expect(saved).to.include({ routeId: String(routeId), estimatedRevenue: 38, operatingCost: 55, grossMargin: -17 })
    expect(saved.parameters).to.deep.equal(parameters)
    expect(saved.routeMetrics).to.deep.equal({ fuelLiters: 2, durationHours: 1.5 })
    expect(saved.products).to.deep.equal([{ id: String(productId), name: 'Fixture product', unitPrice: 12.5, quantity: 3, stock: 8 }])
    expect(await RouteSimulationModel.countDocuments({ routeId: String(routeId) })).to.equal(1)

    const app = express()
    app.use(express.json())
    app.locals.simulationRouteDependencies = {
      checkJwt: (_req: express.Request, res: express.Response, next: express.NextFunction) => { res.locals.userId = String(driverId); next() },
      checkPermission: () => (_req: express.Request, res: express.Response, next: express.NextFunction) => { res.locals.authorizationRole = 'Repartidor'; next() },
      getConfig: () => ({ enabled: true }),
      service: {}
    }
    app.use('/simulation', createSimulationRouter())
    const url = `/simulation/route-scenarios/${saved.id}`
    const detail = await request(app).get(url)
    expect(detail.status).to.equal(200)
    expect(detail.body).to.deep.equal(saved)
    await RoutePlanOperationalModel.updateOne({ _id: operationalId }, { $set: { 'assignments.driverId': String(otherDriverId) } })
    expect((await request(app).get(url)).status).to.equal(404)
    let failure: unknown
    try { await createRealRouteScenario({ ...input, routeId: String(missingFuelId) }, scope) } catch (error) { failure = error }
    expect(failure).to.be.instanceOf(Error)
    expect((failure as Error).message).to.equal('Route metrics unavailable')
    expect(await RouteSimulationModel.countDocuments({ routeId: String(missingFuelId) })).to.equal(0)
    expect(await RoutePlanModel.findById(routeId).lean()).to.deep.equal(beforeRoute)
    expect(await ProductModel.findById(productId).lean()).to.deep.equal(beforeProduct)
    console.log('    verified: scenarios=1 missing-fuel-scenarios=0 route/product unchanged; reassigned driver denied')
  })
})
