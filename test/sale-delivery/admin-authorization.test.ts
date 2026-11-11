import express from 'express'
import { expect } from 'chai'
import mongoose from 'mongoose'
import sinon from 'sinon'
import request from 'supertest'
import UserModel from '../../src/models/user'
import RoleModel from '../../src/models/role'
import { checkPermission } from '../../src/middleware/checkPermission'

describe('central administrator authorization', () => {
  const initialState = mongoose.connection.readyState
  const userId = '507f1f77bcf86cd799439011'
  const roleId = '507f1f77bcf86cd799439012'
  let identity: object
  let databaseUser: object | null
  let databaseRole: object | null
  const app = express()
  app.use((req, _res, next) => { Object.assign(req, { user: identity }); next() })
  const authorize = checkPermission(['manage_roles', 'manage_ownership'])
  app.get('/', (req, res, next) => { void authorize(req, res, next) }, (_req, res) => { res.sendStatus(204) })

  before(() => { mongoose.connection.readyState = 1 })
  after(() => { mongoose.connection.readyState = initialState })
  beforeEach(() => {
    identity = { id: userId, role: { name: 'admin', permissions: [] } }
    databaseUser = { isActive: true, role: roleId }
    databaseRole = { name: 'admin', isActive: true }
    const userQuery: unknown = { maxTimeMS: () => ({ lean: async () => databaseUser }) }
    const roleQuery: unknown = { maxTimeMS: () => ({ lean: async () => databaseRole }) }
    sinon.stub(UserModel, 'findById').returns(userQuery as never)
    sinon.stub(RoleModel, 'findById').returns(roleQuery as never)
  })
  afterEach(() => { sinon.restore(); mongoose.connection.readyState = 1 })

  it('allows a current active admin without token grants', async () => {
    expect((await request(app).get('/')).status).to.equal(204)
  })
  it('uses the current role even when the token predates promotion', async () => {
    identity = { id: userId, role: { name: 'Employee', permissions: [] } }
    expect((await request(app).get('/')).status).to.equal(204)
  })
  it('rejects a demoted admin even with stale token grants', async () => {
    identity = { id: userId, role: { name: 'admin', permissions: ['manage_roles'] } }
    databaseRole = { name: 'Employee', isActive: true }
    expect((await request(app).get('/')).status).to.equal(403)
  })
  it('rejects inactive or missing users and roles', async () => {
    for (const user of [null, { isActive: false, role: roleId }, { isActive: true }]) {
      databaseUser = user
      expect((await request(app).get('/')).status).to.equal(403)
    }
    databaseUser = { isActive: true, role: roleId }
    for (const role of [null, { name: 'admin', isActive: false }]) {
      databaseRole = role
      expect((await request(app).get('/')).status).to.equal(403)
    }
  })
  it('denies revoked grants even when the token still contains them', async () => {
    databaseRole = { name: 'Employee', isActive: true, permissions: [] }
    identity = { id: userId, role: { name: 'Employee', permissions: ['manage_ownership'] } }
    expect((await request(app).get('/')).status).to.equal(403)
  })
  it('allows newly granted permissions without refreshing the token', async () => {
    databaseRole = { name: 'Employee', isActive: true, permissions: ['manage_ownership'] }
    identity = { id: userId, role: { name: 'Employee', permissions: [] } }
    expect((await request(app).get('/')).status).to.equal(204)
  })
  it('uses the new role grants after reassignment, including without a token role', async () => {
    identity = { id: userId }
    databaseRole = { name: 'Manager', isActive: true, permissions: ['manage_roles'] }
    expect((await request(app).get('/')).status).to.equal(204)
    databaseRole = { name: 'Employee', isActive: true, permissions: [] }
    expect((await request(app).get('/')).status).to.equal(403)
    expect((RoleModel.findById as sinon.SinonStub).alwaysCalledWith(roleId)).to.equal(true)
  })
  it('rejects missing identity and malformed permission lists', async () => {
    identity = {}
    expect((await request(app).get('/')).status).to.equal(403)
    identity = { id: userId, role: { permissions: ['manage_roles'] } }
    databaseRole = { name: 'Employee', isActive: true }
    expect((await request(app).get('/')).status).to.equal(403)
  })
  it('fails closed when the database is unavailable', async () => {
    mongoose.connection.readyState = 0
    expect((await request(app).get('/')).status).to.equal(503)
  })
  it('fails closed on role lookup errors', async () => {
    ;(RoleModel.findById as sinon.SinonStub).throws(new Error('lookup failed'))
    expect((await request(app).get('/')).status).to.equal(403)
  })
})
