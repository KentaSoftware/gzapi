import { randomBytes } from 'crypto'
import express from 'express'
import { expect } from 'chai'
import mongoose, { Types } from 'mongoose'
import { sign } from 'jsonwebtoken'
import request from 'supertest'
import { router } from '../../src/routes/routePlan'

const integration = process.env.ROUTE_OWNERSHIP_MONGO_TESTS === '1' ? describe : describe.skip

integration('route ownership against isolated local MongoDB', () => {
  const app = express().use(express.json()).use('/routePlan', router)
  const databaseName = `gzapi_route_ownership_e2e_${randomBytes(16).toString('hex')}`
  const driverA = new Types.ObjectId()
  const driverB = new Types.ObjectId()
  const admin = new Types.ObjectId()
  const ids = Array.from({ length: 4 }, () => new Types.ObjectId())
  let fixtureOwned = false
  const token = (id: Types.ObjectId, role: string): string => sign({ id: String(id), role: { name: role, permissions: ['read_route_plan'] } }, process.env.JWT_SECRET ?? 'NOT_TOKEN_ENV')
  const bearer = (id: Types.ObjectId, role = 'Repartidor'): string => `Bearer ${token(id, role)}`

  before(async () => {
    if (!/^gzapi_route_ownership_e2e_[a-f0-9]{32}$/.test(databaseName)) throw new Error('Unsafe database name')
    await mongoose.connect(`mongodb://127.0.0.1:27017/${databaseName}`, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, autoIndex: false, autoCreate: false })
    const db = mongoose.connection.db
    if (db === undefined || db.databaseName !== databaseName) throw new Error('Unsafe database target')
    const listed = await db.admin().listDatabases({ nameOnly: true })
    if (listed.databases.some((database) => database.name === databaseName)) throw new Error('Fixture database already exists')
    fixtureOwned = true
    await db.collection('users').insertMany([driverA, driverB, admin].map((_id) => ({ _id, nickname: `fixture-${String(_id)}`, isActive: true })))
    await db.collection('routeplans').insertMany(ids.map((_id, index) => ({
      _id,
      planningDate: new Date('2026-10-12T03:00:00Z'),
      zoneSnapshot: { code: index === 1 ? 'SUR' : 'NORTE' },
      ...(index === 3 ? {} : { assignments: { driverId: String(driverA) } }),
      selectedSaleIds: [`sale-${index}`],
      stops: [{ clientId: `client-${index}`, saleIds: [`sale-${index}`], sequence: 1, latitude: index, longitude: index }],
      metrics: { distanceMeters: (index + 1) * 100, durationSeconds: 10, fuelLiters: index + 1 },
      warnings: []
    })))
    await db.collection('routeplanoperationals').insertMany([
      { snapshotId: String(ids[1]), assignments: { driverId: String(driverB) }, status: 'IN_PROGRESS' },
      { snapshotId: String(ids[2]), assignments: {}, status: 'PENDING' }
    ])
  })

  after(async () => {
    const db = mongoose.connection.db
    if (fixtureOwned && db?.databaseName === databaseName) {
      await db.collection('routeplanoperationals').deleteMany({ snapshotId: { $in: ids.map(String) } })
      await db.collection('routeplans').deleteMany({ _id: { $in: ids } })
      await db.collection('users').deleteMany({ _id: { $in: [driverA, driverB, admin] } })
    }
    await mongoose.disconnect()
  })

  it('scopes lists, details, dashboards and current assignments without leaking aggregates', async () => {
    const listA = await request(app).get(`/routePlan?driverId=${String(driverB)}`).set('Authorization', bearer(driverA))
    expect(listA.status).to.equal(200)
    expect(listA.body.map((route: { _id: string }) => route._id)).to.deep.equal([String(ids[0])])
    expect((await request(app).get(`/routePlan/${String(ids[1])}`).set('Authorization', bearer(driverA))).status).to.equal(404)
    expect((await request(app).get(`/routePlan/${String(ids[2])}`).set('Authorization', bearer(driverA))).status).to.equal(404)
    expect((await request(app).get(`/routePlan/${String(ids[3])}`).set('Authorization', bearer(driverA))).status).to.equal(404)
    const dashboardA = await request(app).get('/routePlan/dashboard').set('Authorization', bearer(driverA))
    expect(dashboardA.status).to.equal(200)
    expect(dashboardA.body.kpis.totalDistanceMeters).to.equal(100)
    expect(dashboardA.body.mapLocations).to.deep.equal([])
    expect(dashboardA.body.candidates.eligible).to.deep.equal([])
    expect(JSON.stringify(dashboardA.body)).not.to.include('client-1')
    const dashboardB = await request(app).get('/routePlan/dashboard?serviceDate=2026-10-12&zoneCode=SUR').set('Authorization', bearer(driverB))
    expect(dashboardB.status).to.equal(200)
    expect(dashboardB.body.routes[0].id).to.equal(String(ids[1]))
    expect(dashboardB.body.routes[0].status).to.equal('IN_PROGRESS')
    expect(dashboardB.body.routes[0].assignments.driverId).to.equal(String(driverB))
    const listB = await request(app).get('/routePlan').set('Authorization', bearer(driverB))
    expect(listB.body.map((route: { _id: string }) => route._id)).to.deep.equal([String(ids[1])])
    expect((await request(app).get(`/routePlan/${String(ids[1])}`).set('Authorization', bearer(driverB))).status).to.equal(200)
    const privileged = await request(app).get('/routePlan').set('Authorization', bearer(admin, 'admin'))
    expect(privileged.status).to.equal(200)
    expect(privileged.body).to.have.length(4)
  })

  it('revokes the previous driver after reassignment and allows the new driver', async () => {
    const db = mongoose.connection.db
    if (db === undefined || !fixtureOwned) throw new Error('Fixture database unavailable')
    await db.collection('routeplanoperationals').insertOne({ snapshotId: String(ids[0]), assignments: { driverId: String(driverB) }, status: 'PENDING' })
    expect((await request(app).get(`/routePlan/${String(ids[0])}`).set('Authorization', bearer(driverA))).status).to.equal(404)
    expect((await request(app).get(`/routePlan/${String(ids[0])}`).set('Authorization', bearer(driverB))).status).to.equal(200)
    const dashboard = await request(app).get('/routePlan/dashboard').set('Authorization', bearer(driverB))
    expect(dashboard.body.kpis.totalDistanceMeters).to.equal(300)
  })
})
