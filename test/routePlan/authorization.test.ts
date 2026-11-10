import express from 'express'
import { expect } from 'chai'
import mongoose from 'mongoose'
import { sign } from 'jsonwebtoken'
import sinon from 'sinon'
import request from 'supertest'
import UserModel from '../../src/models/user'
import RoleModel from '../../src/models/role'
import RoutePlanModel from '../../src/models/routePlan'
import RoutePlanOperationalModel from '../../src/models/routePlanOperational'
import ClientModel from '../../src/models/client'
import SaleModel from '../../src/models/sale'
import VehicleModel from '../../src/models/vehicle'
import { router } from '../../src/routes/routePlan'

describe('current database route authorization', () => {
  const app = express().use(express.json()).use('/routePlan', router)
  const initialState = mongoose.connection.readyState
  const id = '507f1f77bcf86cd799439011'
  let role: { name: string, isActive: boolean, permissions: string[] } | null
  let active = true
  const token = (name: string, permissions: string[]): string => sign({ id, role: { name, permissions } }, process.env.JWT_SECRET ?? 'NOT_TOKEN_ENV')

  before(() => { mongoose.connection.readyState = 1 })
  after(() => { mongoose.connection.readyState = initialState })
  beforeEach(() => {
    active = true
    role = { name: 'Repartidor', isActive: true, permissions: ['read_route_plan', 'create_route_plan'] }
    const userQuery: unknown = { maxTimeMS: () => ({ lean: async () => ({ isActive: active, role: id }) }) }
    const roleQuery: unknown = { maxTimeMS: () => ({ lean: async () => role }) }
    sinon.stub(UserModel, 'findById').returns(userQuery as never)
    sinon.stub(RoleModel, 'findById').returns(roleQuery as never)
  })
  afterEach(() => { sinon.restore() })

  it('restricts current drivers despite a privileged stale token', async () => {
    const auth = `Bearer ${token('admin', ['create_route_plan'])}`
    expect((await request(app).post('/routePlan/preview').set('Authorization', auth).send({})).status).to.equal(403)
    const aggregate = sinon.stub(RoutePlanModel, 'aggregate').resolves([] as never)
    expect((await request(app).get('/routePlan').set('Authorization', auth)).status).to.equal(200)
    expect(JSON.stringify(aggregate.firstCall.args[0])).to.include(id)
  })

  it('does not restrict a promoted admin with a stale driver token', async () => {
    role = { name: 'admin', isActive: true, permissions: [] }
    const auth = `Bearer ${token('Repartidor', [])}`
    expect((await request(app).post('/routePlan/preview').set('Authorization', auth).send({})).status).to.equal(400)
    const query: unknown = { sort: () => ({ limit: () => ({ lean: async () => [] }) }) }
    const find = sinon.stub(RoutePlanModel, 'find').returns(query as never)
    expect((await request(app).get('/routePlan').set('Authorization', auth)).status).to.equal(200)
    expect(find.calledOnce).to.equal(true)
  })

  it('uses current grants and fails closed for inactive actors or failed lookups', async () => {
    role = { name: 'Employee', isActive: true, permissions: [] }
    const auth = `Bearer ${token('Employee', ['create_route_plan'])}`
    expect((await request(app).post('/routePlan/preview').set('Authorization', auth).send({})).status).to.equal(403)
    role.permissions = ['create_route_plan']
    expect((await request(app).post('/routePlan/preview').set('Authorization', `Bearer ${token('Employee', [])}`).send({})).status).to.equal(400)
    active = false
    expect((await request(app).post('/routePlan/preview').set('Authorization', auth).send({})).status).to.equal(403)
    active = true
    ;(RoleModel.findById as sinon.SinonStub).throws(new Error('lookup failure'))
    expect((await request(app).post('/routePlan/preview').set('Authorization', auth).send({})).status).to.equal(403)
  })
})

describe('route plan permission boundaries', () => {
  const app = express().use(express.json()).use('/routePlan', router)
  const readyState = mongoose.connection.readyState
  let permissions: string[] = []
  const token = (grants: string[]): string => {
    permissions = grants
    return sign({ id: '507f1f77bcf86cd799439011', role: { name: 'Custom', permissions: grants } }, process.env.JWT_SECRET ?? 'NOT_TOKEN_ENV')
  }

  before(() => { mongoose.connection.readyState = 1 })
  after(() => { mongoose.connection.readyState = readyState })
  beforeEach(() => {
    const query: unknown = { maxTimeMS: () => ({ lean: async () => ({ isActive: true, role: 'role' }) }) }
    sinon.stub(UserModel, 'findById').returns(query as never)
    const roleQuery: unknown = { maxTimeMS: () => ({ lean: async () => ({ name: 'Custom', isActive: true, permissions }) }) }
    sinon.stub(RoleModel, 'findById').returns(roleQuery as never)
  })
  afterEach(() => { sinon.restore() })

  it('rejects unauthenticated requests', async () => {
    expect((await request(app).get('/routePlan/dashboard')).status).to.equal(401)
  })

  it('fails closed when the authenticated role identity is missing', async () => {
    const incomplete = sign({ id: '507f1f77bcf86cd799439011', role: { permissions: ['read_route_plan'] } }, process.env.JWT_SECRET ?? 'NOT_TOKEN_ENV')
    expect((await request(app).get('/routePlan/dashboard').set('Authorization', `Bearer ${incomplete}`)).status).to.equal(403)
  })

  for (const path of ['/dashboard', '/candidates', '/assignment-options', '/', '/config', '/507f1f77bcf86cd799439012']) {
    it(`requires read permission for GET ${path}`, async () => {
      expect((await request(app).get(`/routePlan${path}`).set('Authorization', `Bearer ${token([])}`)).status).to.equal(403)
    })
  }

  for (const path of ['/preview', '/']) {
    it(`does not allow read-only users to POST ${path}`, async () => {
      expect((await request(app).post(`/routePlan${path}`).set('Authorization', `Bearer ${token(['read_route_plan'])}`).send({})).status).to.equal(403)
    })
  }

  it('requires the route configuration grant for configuration writes', async () => {
    expect((await request(app).patch('/routePlan/config').set('Authorization', `Bearer ${token(['create_route_plan'])}`).send({})).status).to.equal(403)
    expect((await request(app).patch('/routePlan/config').set('Authorization', `Bearer ${token(['manage_route_config'])}`).send({})).status).to.equal(400)
  })

  it('allows create permission through to input validation without read permission', async () => {
    expect((await request(app).post('/routePlan/preview').set('Authorization', `Bearer ${token(['create_route_plan'])}`).send({})).status).to.not.equal(403)
  })
})

describe('assigned driver route privacy', () => {
  const app = express().use(express.json()).use('/routePlan', router)
  const readyState = mongoose.connection.readyState
  const driverA = '507f1f77bcf86cd799439011'
  const driverB = '507f1f77bcf86cd799439012'
  const first = '507f1f77bcf86cd799439021'
  const second = '507f1f77bcf86cd799439022'
  let roleName = 'Repartidor'
  const token = (id: string, name = 'Repartidor'): string => {
    roleName = name
    return sign({ id, role: { name, permissions: ['read_route_plan'] } }, process.env.JWT_SECRET ?? 'NOT_TOKEN_ENV')
  }
  const snapshots = [
    { _id: first, assignments: { driverId: driverA }, zoneSnapshot: { code: 'NORTE' }, selectedSaleIds: ['sale-a'], stops: [{ clientId: 'client-a', saleIds: ['sale-a'], sequence: 1, latitude: 1, longitude: 1 }], metrics: { distanceMeters: 100, durationSeconds: 10, fuelLiters: 1 }, warnings: [] },
    { _id: second, assignments: { driverId: driverA }, zoneSnapshot: { code: 'SUR' }, selectedSaleIds: ['sale-b'], stops: [{ clientId: 'client-b', saleIds: ['sale-b'], sequence: 1, latitude: 2, longitude: 2 }], metrics: { distanceMeters: 900, durationSeconds: 90, fuelLiters: 9 }, warnings: [] }
  ]
  const projections = [{ snapshotId: second, assignments: { driverId: driverB }, status: 'PENDING' }]

  before(() => { mongoose.connection.readyState = 1 })
  after(() => { mongoose.connection.readyState = readyState })
  beforeEach(() => {
    roleName = 'Repartidor'
    const active: unknown = { maxTimeMS: () => ({ lean: async () => ({ isActive: true, role: 'role' }) }) }
    sinon.stub(UserModel, 'findById').returns(active as never)
    const roleQuery: unknown = { maxTimeMS: () => ({ lean: async () => ({ name: roleName, isActive: true, permissions: ['read_route_plan'] }) }) }
    sinon.stub(RoleModel, 'findById').returns(roleQuery as never)
    sinon.stub(RoutePlanModel, 'aggregate').callsFake((pipeline: unknown) => {
      const text = JSON.stringify(pipeline)
      const driver = text.includes(driverA) ? driverA : driverB
      const filter = (pipeline as Array<{ $match?: Record<string, unknown> }>)[0].$match ?? {}
      const result = snapshots.filter((snapshot) => (projections.find((p) => p.snapshotId === snapshot._id)?.assignments.driverId ?? snapshot.assignments.driverId) === driver && (filter._id === undefined || String(filter._id) === snapshot._id) && (filter['zoneSnapshot.code'] === undefined || filter['zoneSnapshot.code'] === snapshot.zoneSnapshot.code))
        .map((snapshot) => ({ ...snapshot, operational: projections.filter((projection) => projection.snapshotId === snapshot._id) }))
      return Promise.resolve(result) as never
    })
    sinon.stub(RoutePlanModel, 'find').callsFake((filter: unknown) => {
      const ids = (filter as { _id?: { $in?: string[] } })._id?.$in
      const zone = (filter as Record<string, unknown>)['zoneSnapshot.code']
      const result = snapshots.filter((snapshot) => (ids === undefined || ids.map(String).includes(snapshot._id)) && (zone === undefined || snapshot.zoneSnapshot.code === zone))
      const query: unknown = { sort: () => ({ limit: () => ({ lean: async () => result }) }) }
      return query as never
    })
    sinon.stub(RoutePlanModel, 'findById').callsFake((id: unknown) => {
      const query: unknown = { lean: async () => snapshots.find((snapshot) => snapshot._id === String(id)) ?? null }
      return query as never
    })
    sinon.stub(RoutePlanOperationalModel, 'find').callsFake(() => {
      const query: unknown = { lean: async () => projections }
      return query as never
    })
    sinon.stub(ClientModel, 'find').throws(new Error('Unexpected global client read'))
    sinon.stub(SaleModel, 'find').throws(new Error('Unexpected global sale read'))
    const emptyLabels: unknown = { lean: async () => [] }
    sinon.stub(UserModel, 'find').returns(emptyLabels as never)
    sinon.stub(VehicleModel, 'find').returns(emptyLabels as never)
  })
  afterEach(() => { sinon.restore() })

  it('filters the dashboard before metrics and never loads global candidates or locations', async () => {
    const response = await request(app).get(`/routePlan/dashboard?driverId=${driverB}`).set('Authorization', `Bearer ${token(driverA)}`)
    expect(response.status).to.equal(200)
    expect(response.body.routes.map((route: { id: string }) => route.id)).to.deep.equal([first])
    expect(response.body.kpis.activeRoutes).to.equal(1)
    expect(response.body.kpis.totalDistanceMeters).to.equal(100)
    expect(response.body.kpis.estimatedFuelLiters).to.equal(1)
    expect(response.body.candidates.eligible).to.deep.equal([])
    expect(response.body.mapLocations).to.deep.equal([])
    expect(JSON.stringify(response.body)).not.to.include('client-b')
  })

  it('uses current assignment for list and detail, ignoring forged driver filters', async () => {
    const list = await request(app).get(`/routePlan?driverId=${driverB}`).set('Authorization', `Bearer ${token(driverA)}`)
    expect(list.status).to.equal(200)
    expect(list.body.map((route: { _id: string }) => route._id)).to.deep.equal([first])
    expect((await request(app).get(`/routePlan/${second}?driverId=${driverA}`).set('Authorization', `Bearer ${token(driverA)}`)).status).to.equal(404)
    expect((await request(app).get(`/routePlan/${second}`).set('Authorization', `Bearer ${token(driverB)}`)).status).to.equal(200)
    const pipeline = JSON.stringify((RoutePlanModel.aggregate as sinon.SinonStub).firstCall.args[0])
    expect(pipeline).to.include('operational.assignments.driverId')
    expect(pipeline).to.include('$assignments.driverId')
    expect(pipeline).to.include(driverA)
  })

  it('reads authorized driver snapshots in the ownership aggregation rather than a second snapshot query', async () => {
    ;(RoutePlanModel.find as sinon.SinonStub).throws(new Error('Unexpected second snapshot read'))
    ;(RoutePlanModel.findById as sinon.SinonStub).throws(new Error('Unexpected second snapshot read'))
    const response = await request(app).get('/routePlan').set('Authorization', `Bearer ${token(driverA)}`)
    expect(response.status).to.equal(200)
  })

  it('does not expose another driver route through date and zone filters', async () => {
    const response = await request(app).get(`/routePlan/dashboard?serviceDate=2026-10-12&zoneCode=SUR&driverId=${driverB}`).set('Authorization', `Bearer ${token(driverA)}`)
    expect(response.status).to.equal(200)
    expect(response.body.routes).to.deep.equal([])
    expect(response.body.kpis.totalDistanceMeters).to.equal(null)
    expect(response.body.mapLocations).to.deep.equal([])
  })

  it('denies generation inputs and operational writes to read-only drivers', async () => {
    for (const path of ['/candidates', '/assignment-options']) {
      expect((await request(app).get(`/routePlan${path}`).set('Authorization', `Bearer ${token(driverA)}`)).status).to.equal(403)
    }
    expect((await request(app).patch(`/routePlan/${first}/operational`).set('Authorization', `Bearer ${token(driverA)}`).send({ driverId: driverB })).status).to.equal(403)
    const elevated = sign({ id: driverA, role: { name: 'Repartidor', permissions: ['read_route_plan', 'create_route_plan', 'manage_route_config'] } }, process.env.JWT_SECRET ?? 'NOT_TOKEN_ENV')
    expect((await request(app).post('/routePlan/preview').set('Authorization', `Bearer ${elevated}`).send({})).status).to.equal(403)
    expect((await request(app).patch('/routePlan/config').set('Authorization', `Bearer ${elevated}`).send({})).status).to.equal(403)
  })

  it('preserves the unscoped payload for a properly granted non-driver', async () => {
    const emptyCursor = { async * [Symbol.asyncIterator] () {} }
    const sorted = { lean: () => ({ cursor: () => emptyCursor }), limit: () => ({ lean: async () => [] }) }
    const emptyQuery: unknown = { lean: async () => [], sort: () => sorted }
    ;(SaleModel.find as sinon.SinonStub).returns(emptyQuery)
    ;(ClientModel.find as sinon.SinonStub).returns(emptyQuery)
    const response = await request(app).get('/routePlan/dashboard').set('Authorization', `Bearer ${token(driverA, 'Administración')}`)
    expect(response.status).to.equal(200)
    expect(response.body.routes.map((route: { id: string }) => route.id)).to.deep.equal([first, second])
    expect(response.body.kpis.totalDistanceMeters).to.equal(1000)
    expect((RoutePlanModel.aggregate as sinon.SinonStub).called).to.equal(false)
  })
})
