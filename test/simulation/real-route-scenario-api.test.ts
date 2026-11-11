import { expect } from 'chai'
import express from 'express'
import request from 'supertest'
import sinon from 'sinon'
import { Types } from 'mongoose'
import { createSimulationRouter } from '../../src/routes/simulation'
import * as routePlan from '../../src/services/routePlan'
import RouteSimulationModel from '../../src/models/routeSimulation'
import RoutePlanModel from '../../src/models/routePlan'

describe('real route scenario HTTP', () => {
  const routeId = '000000000000000000000001'
  const actor = '000000000000000000000002'
  const input = { routeId, parameters: { fuelPricePerLiter: 1, hourlyRate: 2, generalCosts: 3, includeSurplus: true }, products: [] }
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.locals.simulationRouteDependencies = {
    checkJwt: (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.headers.authorization !== 'Bearer valid') { res.sendStatus(401); return }
      res.locals.userId = actor
      next()
    },
    checkPermission: (action: string, options: { currentRole?: boolean }) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (!['simulation:write', 'simulation:read'].includes(action) || options?.currentRole !== true || req.headers['x-inactive'] === 'yes') { res.sendStatus(403); return }
      res.locals.authorizationRole = req.headers['x-role'] === 'admin' ? 'admin' : 'Repartidor'
      next()
    },
    getConfig: () => ({ enabled: true }),
    service: {}
  }
  app.use('/simulation', createSimulationRouter())
  afterEach(() => sinon.restore())

  it('reads only currently assigned scenarios and does not trust forged scope', async () => {
    const scenarioId = '000000000000000000000003'
    const scenario = { _id: new Types.ObjectId(scenarioId), routeId, routeMetrics: { fuelLiters: 2, durationHours: 1 }, parameters: input.parameters, products: [], estimatedRevenue: 0, operatingCost: 7, grossMargin: -7 }
    const query = { lean: async () => scenario }
    sinon.stub(RouteSimulationModel, 'findById').returns(query as never)
    const driver = sinon.stub(routePlan, 'getDriverSnapshots')
    driver.onFirstCall().resolves([{ snapshot: { _id: new Types.ObjectId(routeId) } }] as never)
    driver.onSecondCall().resolves([])
    const url = `/simulation/route-scenarios/${scenarioId}`
    const allowed = await request(app).get(url).set('Authorization', 'Bearer valid')
    expect(allowed.status).to.equal(200)
    expect(allowed.body).to.include({ id: scenarioId, routeId, operatingCost: 7 })
    const denied = await request(app).get(`${url}?scope=global&userId=forged`).set('Authorization', 'Bearer valid')
    expect(denied.status).to.equal(404)
    expect(driver.secondCall.args[0]).to.equal(actor)
    expect((await request(app).get(url).set('Authorization', 'Bearer valid').set('x-inactive', 'yes')).status).to.equal(403)
  })

  it('uses the existing global policy and hides missing or invalid scenarios', async () => {
    const scenarioId = '000000000000000000000003'
    const scenario = { _id: new Types.ObjectId(scenarioId), routeId, routeMetrics: {}, parameters: input.parameters, products: [], estimatedRevenue: 0, operatingCost: 0, grossMargin: 0 }
    const find = sinon.stub(RouteSimulationModel, 'findById')
    const found = { lean: async () => scenario }
    const absent = { lean: async () => null }
    const route = { lean: async () => ({ _id: new Types.ObjectId(routeId) }) }
    find.onFirstCall().returns(found as never)
    find.onSecondCall().returns(absent as never)
    sinon.stub(RoutePlanModel, 'findById').returns(route as never)
    const url = `/simulation/route-scenarios/${scenarioId}`
    expect((await request(app).get(url).set('Authorization', 'Bearer valid').set('x-role', 'admin')).status).to.equal(200)
    const missing = await request(app).get(url).set('Authorization', 'Bearer valid').set('x-role', 'admin')
    const invalid = await request(app).get('/simulation/route-scenarios/forged').set('Authorization', 'Bearer valid').set('x-role', 'admin')
    expect(missing.status).to.equal(404)
    expect(invalid.status).to.equal(404)
    expect(invalid.body).to.deep.equal(missing.body)
    expect((await request(app).get(url)).status).to.equal(401)
    const config = app.locals.simulationRouteDependencies.getConfig
    app.locals.simulationRouteDependencies.getConfig = () => ({ enabled: false })
    try {
      expect((await request(app).get(url).set('Authorization', 'Bearer valid')).status).to.equal(503)
    } finally { app.locals.simulationRouteDependencies.getConfig = config }
  })

  it('requires authentication and the current active role', async () => {
    expect((await request(app).post('/simulation/route-scenarios').send(input)).status).to.equal(401)
    expect((await request(app).post('/simulation/route-scenarios').set('Authorization', 'Bearer valid').set('x-inactive', 'yes').send(input)).status).to.equal(403)
  })

  for (const quantity of [1.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
    it(`rejects invalid product quantity ${quantity} before repository access`, async () => {
      const driver = sinon.stub(routePlan, 'getDriverSnapshots').rejects(new Error('database unavailable'))
      const response = await request(app).post('/simulation/route-scenarios').set('Authorization', 'Bearer valid')
        .send({ ...input, products: [{ id: routeId, quantity }] })
      expect(response.status).to.equal(400)
      expect(response.body.code).to.equal('SIMULATION_INPUT_INVALID')
      expect(driver.called).to.equal(false)
    })
  }

  it('accepts zero quantity while retaining stock validation', async () => {
    sinon.stub(routePlan, 'getDriverSnapshots').resolves([{ snapshot: { _id: new Types.ObjectId(routeId), metrics: { fuelLiters: 2, durationSeconds: 3600 } } }] as never)
    const product = await import('../../src/models/product')
    const query = { lean: async () => [{ _id: new Types.ObjectId(routeId), descripcion: 'Product', precioUnitario: 1, stock: 0 }] }
    const saved = { _id: new Types.ObjectId('000000000000000000000003') }
    sinon.stub(product.default, 'find').returns(query as never)
    sinon.stub(RouteSimulationModel, 'create').resolves(saved as never)
    const zero = await request(app).post('/simulation/route-scenarios').set('Authorization', 'Bearer valid').send({ ...input, products: [{ id: routeId, quantity: 0 }] })
    expect(zero.status).to.equal(201)
    const insufficient = await request(app).post('/simulation/route-scenarios').set('Authorization', 'Bearer valid').send({ ...input, products: [{ id: routeId, quantity: 1 }] })
    expect(insufficient.status).to.equal(422)
  })

  it('rejects forged scope and never allows a driver to access another route', async () => {
    const driver = sinon.stub(routePlan, 'getDriverSnapshots').resolves([])
    const forged = await request(app).post('/simulation/route-scenarios').set('Authorization', 'Bearer valid').send({ ...input, scope: { kind: 'global' } })
    expect(forged.status).to.equal(400)
    const denied = await request(app).post('/simulation/route-scenarios').set('Authorization', 'Bearer valid').send(input)
    expect(denied.status).to.equal(404)
    expect(driver.firstCall.args[0]).to.equal(actor)
  })

  it('returns the persisted identifier and exact route results', async () => {
    sinon.stub(routePlan, 'getDriverSnapshots').resolves([{ snapshot: { _id: new Types.ObjectId(routeId), metrics: { fuelLiters: 2, durationSeconds: 3600 } } }] as never)
    const product = await import('../../src/models/product')
    const query = { lean: async () => [] }
    const saved = { _id: new Types.ObjectId('000000000000000000000003') }
    sinon.stub(product.default, 'find').returns(query as never)
    sinon.stub(RouteSimulationModel, 'create').resolves(saved as never)
    const response = await request(app).post('/simulation/route-scenarios').set('Authorization', 'Bearer valid').send(input)
    expect(response.status).to.equal(201)
    expect(response.body).to.include({ id: '000000000000000000000003', routeId, operatingCost: 7 })
  })

  it('fails closed for missing route metrics and repository errors', async () => {
    const driver = sinon.stub(routePlan, 'getDriverSnapshots')
    driver.onFirstCall().resolves([{ snapshot: { _id: new Types.ObjectId(routeId), metrics: { fuelLiters: NaN, durationSeconds: 1 } } }] as never)
    driver.onSecondCall().rejects(new Error('sensitive database details'))
    const invalid = await request(app).post('/simulation/route-scenarios').set('Authorization', 'Bearer valid').send(input)
    expect(invalid.status).to.equal(422)
    const failure = await request(app).post('/simulation/route-scenarios').set('Authorization', 'Bearer valid').send(input)
    expect(failure.status).to.equal(503)
    expect(JSON.stringify(failure.body)).not.to.contain('sensitive')
  })

  it('rejects invalid numbers, oversized product lists and disabled simulation', async () => {
    const invalid = await request(app).post('/simulation/route-scenarios').set('Authorization', 'Bearer valid').send({ ...input, parameters: { ...input.parameters, hourlyRate: -1 } })
    expect(invalid.status).to.equal(400)
    const oversized = await request(app).post('/simulation/route-scenarios').set('Authorization', 'Bearer valid').send({ ...input, products: Array.from({ length: 10001 }, () => ({ id: routeId, quantity: 1 })) })
    expect(oversized.status).to.equal(400)
    const config = app.locals.simulationRouteDependencies.getConfig
    app.locals.simulationRouteDependencies.getConfig = () => ({ enabled: false })
    try {
      expect((await request(app).post('/simulation/route-scenarios').set('Authorization', 'Bearer valid').send(input)).status).to.equal(503)
    } finally { app.locals.simulationRouteDependencies.getConfig = config }
  })
})
