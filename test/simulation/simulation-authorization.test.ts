import { expect } from 'chai'
import express from 'express'
import mongoose from 'mongoose'
import sinon from 'sinon'
import request from 'supertest'

import { readSimulationConfig } from '../../src/config/simulation'
import { checkPermission } from '../../src/middleware/checkPermission'
import { checkJwt } from '../../src/middleware/session'
import RoleModel from '../../src/models/role'
import UserModel from '../../src/models/user'
import { createSimulationRouter } from '../../src/routes/simulation'
import * as jwt from '../../src/utils/jwt.handle'

describe('Simulation authorization integration', () => {
  const actor = '000000000000000000000002'
  const app = express()
  const list = sinon.stub().resolves({ items: [], page: 1, pageSize: 8, total: 0 })
  app.locals.simulationRouteDependencies = {
    checkJwt,
    checkPermission,
    getConfig: () => readSimulationConfig({ SIMULATION_ENABLED: 'false' }),
    routeScenarioList: list,
    service: {}
  }
  app.use('/simulation', createSimulationRouter())

  beforeEach(() => {
    mongoose.connection.readyState = 1
    sinon.stub(jwt, 'verifyToken').callsFake(async (token) => {
      if (token !== 'valid') throw new Error('invalid token')
      return { id: actor }
    })
    list.resetHistory()
  })

  afterEach(() => {
    sinon.restore()
    mongoose.connection.readyState = 0
  })

  const authorize = (role: string, permissions: string[], userActive = true, roleActive = true): void => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    sinon.stub(UserModel, 'findById').returns({
      maxTimeMS: () => ({ lean: async () => ({ isActive: userActive, role: 'role-id' }) })
    } as never)
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    sinon.stub(RoleModel, 'findById').returns({
      maxTimeMS: () => ({ lean: async () => ({ name: role, permissions, isActive: roleActive }) })
    } as never)
  }

  it('allows an active admin through the real guards with the old flag false', async () => {
    authorize('admin', [])
    const response = await request(app).get('/simulation/route-scenarios').set('Authorization', 'Bearer valid')
    expect(response.status).to.equal(200)
    expect(list.calledOnceWith(1, { kind: 'global' })).to.equal(true)
  })

  it('rejects missing and invalid JWTs before authorization', async () => {
    expect((await request(app).get('/simulation/route-scenarios')).status).to.equal(401)
    expect((await request(app).get('/simulation/route-scenarios').set('Authorization', 'Bearer invalid')).status).to.equal(401)
    expect(list.called).to.equal(false)
  })

  it('rejects an ungranted or inactive user or role', async () => {
    authorize('Other', [])
    expect((await request(app).get('/simulation/route-scenarios').set('Authorization', 'Bearer valid')).status).to.equal(403)
    sinon.restore()
    sinon.stub(jwt, 'verifyToken').resolves({ id: actor })
    authorize('admin', [], false)
    expect((await request(app).get('/simulation/route-scenarios').set('Authorization', 'Bearer valid')).status).to.equal(403)
    sinon.restore()
    sinon.stub(jwt, 'verifyToken').resolves({ id: actor })
    authorize('admin', [], true, false)
    expect((await request(app).get('/simulation/route-scenarios').set('Authorization', 'Bearer valid')).status).to.equal(403)
    expect(list.called).to.equal(false)
  })

  it('retains driver-scoped reads for an explicitly granted role', async () => {
    authorize('Repartidor', ['simulation:read'])
    const response = await request(app).get('/simulation/route-scenarios').set('Authorization', 'Bearer valid')
    expect(response.status).to.equal(200)
    expect(list.calledOnceWith(1, { kind: 'driver', userId: actor })).to.equal(true)
  })
})
