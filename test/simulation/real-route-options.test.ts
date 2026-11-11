import { expect } from 'chai'
import express from 'express'
import request from 'supertest'
import sinon from 'sinon'
import { createSimulationRouter } from '../../src/routes/simulation'
import { listRouteOptions } from '../../src/services/routeSimulation'
import * as routePlan from '../../src/services/routePlan'
import RoutePlanModel from '../../src/models/routePlan'
import { Types } from 'mongoose'

describe('simulation real route options', () => {
  it('requires authentication and simulation read permission before listing', async () => {
    const app = express()
    let reads = 0
    app.locals.simulationRouteDependencies = {
      checkJwt: (req: express.Request, res: express.Response, next: express.NextFunction) => req.headers.authorization === undefined ? res.sendStatus(401) : next(),
      checkPermission: (action: string) => (_req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (action !== 'simulation:read' || res.req.headers['x-grant'] !== 'yes') { res.sendStatus(403); return }
        res.locals.authorizationRole = 'admin'
        next()
      },
      getConfig: () => ({ enabled: true }),
      service: {},
      routeOptions: async () => { reads++; return { items: [], hasMore: false, nextCursor: null } }
    }
    app.use('/simulation', createSimulationRouter())
    expect((await request(app).get('/simulation/routes')).status).to.equal(401)
    expect((await request(app).get('/simulation/routes').set('Authorization', 'token')).status).to.equal(403)
    const response = await request(app).get('/simulation/routes').set('Authorization', 'token').set('x-grant', 'yes')
    expect(response.status).to.equal(200)
    expect(response.body).to.deep.equal({ items: [], hasMore: false, nextCursor: null })
    expect(reads).to.equal(1)
  })

  it('scopes drivers and fails closed when the current role is missing', async () => {
    const app = express()
    const scopes: Array<string | undefined> = []
    app.locals.simulationRouteDependencies = {
      checkJwt: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
      checkPermission: (_action: string, options: { currentRole?: boolean }) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
        expect(options.currentRole).to.equal(true)
        res.locals.authorizationRole = req.headers['x-role']
        res.locals.userId = 'driver-id'
        next()
      },
      getConfig: () => ({ enabled: true }),
      service: {},
      routeOptions: async (scope?: string) => { scopes.push(scope); return { items: [], hasMore: false, nextCursor: null } }
    }
    app.use('/simulation', createSimulationRouter())
    expect((await request(app).get('/simulation/routes')).status).to.equal(403)
    expect((await request(app).get('/simulation/routes').set('x-role', 'Repartidor')).status).to.equal(200)
    expect(scopes).to.deep.equal(['driver-id'])
  })

  it('returns effective assignment and saved metrics without staleness writes', async () => {
    const snapshot = { _id: 'actual-id', planningDate: new Date('2026-01-01'), zoneSnapshot: { code: 'z', name: 'Zone', normalizedName: 'zone' }, metrics: { distanceMeters: 500, durationSeconds: 60, stopCount: 1 }, assignments: { driverId: 'old', vehicleId: 'old' } }
    const aggregate = sinon.stub(RoutePlanModel, 'aggregate').resolves([{ ...snapshot, operational: [{ assignments: { driverId: 'new', vehicleId: 'new' } }] }])
    const driver = sinon.stub(routePlan, 'getDriverSnapshots').resolves([{ snapshot, projection: { assignments: { driverId: 'new', vehicleId: 'new' } } }] as never)
    try {
      const global = await listRouteOptions()
      const scoped = await listRouteOptions('new')
      expect(global.items[0]).to.include({ _id: 'actual-id' })
      expect(global.items[0].metrics).to.deep.equal(snapshot.metrics)
      expect(global.items[0].zoneSnapshot).to.deep.equal(snapshot.zoneSnapshot)
      expect(global.items[0].assignments).to.deep.equal({ driverId: 'new', vehicleId: 'new' })
      expect(scoped).to.deep.equal(global)
      expect(driver.firstCall.args[0]).to.equal('new')
      expect(aggregate.calledOnce).to.equal(true)
    } finally {
      sinon.restore()
    }
  })

  it('paginates over more than 100 driver-visible snapshots using the last ID', async () => {
    const snapshots = Array.from({ length: 102 }, (_, i) => ({
      _id: new Types.ObjectId((102 - i).toString(16).padStart(24, '0')),
      planningDate: new Date('2026-01-01'),
      zoneSnapshot: { code: 'z', name: 'Zone', normalizedName: 'zone' },
      metrics: { distanceMeters: 500, durationSeconds: 60, stopCount: 1 }
    }))
    const driver = sinon.stub(routePlan, 'getDriverSnapshots')
    driver.onFirstCall().resolves(snapshots.slice(0, 101).map((snapshot) => ({ snapshot })) as never)
    driver.onSecondCall().resolves(snapshots.slice(100).map((snapshot) => ({ snapshot })) as never)
    try {
      const first = await listRouteOptions('driver')
      expect(first.items).to.have.length(100)
      expect(first.hasMore).to.equal(true)
      expect(first.nextCursor).to.equal(String(snapshots[99]._id))
      const second = await listRouteOptions('driver', first.nextCursor ?? undefined)
      expect(second.items.map((item) => item._id)).to.deep.equal(snapshots.slice(100).map((snapshot) => String(snapshot._id)))
      expect(second.hasMore).to.equal(false)
      expect(second.nextCursor).to.equal(null)
      expect(driver.secondCall.args[0]).to.equal('driver')
      expect(driver.secondCall.args[1]).to.deep.equal({ _id: { $lt: snapshots[99]._id } })
      expect(driver.secondCall.args[2]).to.deep.equal({ _id: -1 })
      expect(driver.secondCall.args[3]).to.equal(101)
    } finally { sinon.restore() }
  })

  it('uses the same cursor boundary for unrestricted reads', async () => {
    const id = new Types.ObjectId('000000000000000000000099')
    const aggregate = sinon.stub(RoutePlanModel, 'aggregate').resolves([])
    try {
      expect(await listRouteOptions(undefined, String(id))).to.deep.equal({ items: [], hasMore: false, nextCursor: null })
      const pipeline = aggregate.firstCall.args[0]
      expect(pipeline.slice(0, 3)).to.deep.equal([{ $match: { _id: { $lt: id } } }, { $sort: { _id: -1 } }, { $limit: 101 }])
    } finally { sinon.restore() }
  })

  it('rejects invalid cursors before invoking the repository', async () => {
    const app = express()
    let calls = 0
    app.locals.simulationRouteDependencies = {
      checkJwt: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
      checkPermission: () => (_req: express.Request, res: express.Response, next: express.NextFunction) => { res.locals.authorizationRole = 'admin'; next() },
      getConfig: () => ({ enabled: true }),
      service: {},
      routeOptions: async () => { calls++; return { items: [], hasMore: false, nextCursor: null } }
    }
    app.use('/simulation', createSimulationRouter())
    for (const query of ['?cursor=', '?cursor=invalid', '?cursor=000000000000000000000001&cursor=000000000000000000000002']) {
      const response = await request(app).get(`/simulation/routes${query}`)
      expect(response.status).to.equal(400)
      expect(response.body.code).to.equal('INVALID_ROUTE_CURSOR')
    }
    expect(calls).to.equal(0)
    const response = await request(app).get('/simulation/routes?cursor=000000000000000000000001')
    expect(response.status).to.equal(200)
    expect(response.body).to.deep.equal({ items: [], hasMore: false, nextCursor: null })
    expect(calls).to.equal(1)
  })
})
