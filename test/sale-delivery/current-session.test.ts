import express from 'express'
import { expect } from 'chai'
import mongoose from 'mongoose'
import sinon from 'sinon'
import request from 'supertest'
import UserModel from '../../src/models/user'
import RoleModel from '../../src/models/role'
import * as jwt from '../../src/utils/jwt.handle'
import { router } from '../../src/routes/auth'

describe('GET /auth/me', () => {
  const userId = '507f1f77bcf86cd799439011'
  const roleId = '507f1f77bcf86cd799439012'
  const initialState = mongoose.connection.readyState
  const app = express().use('/auth', router)
  let identity: object
  let databaseUser: object | null
  let databaseRole: object | null

  beforeEach(() => {
    mongoose.connection.readyState = 1
    identity = { id: userId, role: { name: 'admin', permissions: ['stale'] } }
    databaseUser = { _id: userId, nickname: 'operator', password: 'secret', isActive: true, role: roleId }
    databaseRole = { _id: roleId, name: 'Employee', isActive: true, permissions: ['read_sales'] }
    sinon.stub(jwt, 'verifyToken').callsFake(async () => identity)
    const query = (getValue: () => object | null): unknown => {
      const result = { select: () => result, maxTimeMS: () => result, lean: async () => getValue() }
      return result
    }
    sinon.stub(UserModel, 'findById').returns(query(() => databaseUser) as never)
    sinon.stub(RoleModel, 'findById').returns(query(() => databaseRole) as never)
  })
  afterEach(() => { sinon.restore(); mongoose.connection.readyState = initialState })

  const getSession = async (): Promise<request.Response> => await request(app).get('/auth/me').set('Authorization', 'Bearer token')

  it('returns only the current database identity and grants, never stale JWT grants or password', async () => {
    const response = await getSession()
    expect(response.status).to.equal(200)
    expect(response.body).to.deep.equal({ id: userId, nickname: 'operator', role: { id: roleId, name: 'Employee' }, permissions: ['read_sales'], isAdmin: false })
  })
  it('recognizes promotion using the current database role', async () => {
    identity = { id: userId, role: { name: 'Employee' } }
    databaseRole = { _id: roleId, name: 'admin', isActive: true, permissions: [] }
    expect((await getSession()).body.isAdmin).to.equal(true)
  })
  it('rejects missing and invalid credentials', async () => {
    expect((await request(app).get('/auth/me')).status).to.equal(401)
    ;(jwt.verifyToken as sinon.SinonStub).rejects(new Error('invalid'))
    expect((await getSession()).status).to.equal(401)
  })
  it('rejects malformed subject identifiers without querying the database', async () => {
    for (const id of [undefined, '', 'not-an-id', 42, 'abcdefghijkl']) {
      identity = { id }
      expect((await getSession()).status).to.equal(401)
    }
    expect((UserModel.findById as sinon.SinonStub).called).to.equal(false)
  })
  it('rejects missing and inactive users or roles', async () => {
    for (const user of [null, { isActive: false, role: roleId }, { isActive: true }]) {
      databaseUser = user
      expect((await getSession()).status).to.equal(403)
    }
    databaseUser = { _id: userId, nickname: 'operator', isActive: true, role: roleId }
    for (const role of [null, { isActive: false, name: 'admin' }]) {
      databaseRole = role
      expect((await getSession()).status).to.equal(403)
    }
  })
  it('fails closed on disconnection and lookup errors', async () => {
    mongoose.connection.readyState = 0
    expect((await getSession()).status).to.equal(503)
    mongoose.connection.readyState = 1
    ;(UserModel.findById as sinon.SinonStub).throws(new Error('lookup failed'))
    expect((await getSession()).status).to.equal(503)
    ;(UserModel.findById as sinon.SinonStub).restore()
    const userQuery: unknown = { select: () => ({ maxTimeMS: () => ({ lean: async () => databaseUser }) }) }
    sinon.stub(UserModel, 'findById').returns(userQuery as never)
    ;(RoleModel.findById as sinon.SinonStub).throws(new Error('lookup failed'))
    expect((await getSession()).status).to.equal(503)
  })
})
