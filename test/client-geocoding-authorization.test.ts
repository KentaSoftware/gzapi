import express from 'express'
import { expect } from 'chai'
import mongoose from 'mongoose'
import { sign } from 'jsonwebtoken'
import sinon from 'sinon'
import request from 'supertest'
import UserModel from '../src/models/user'
import RoleModel from '../src/models/role'
import ClientModel from '../src/models/client'
import * as provider from '../src/services/geocodingProvider'
import { router } from '../src/routes/client'

describe('client location authorization', () => {
  const app = express().use(express.json()).use('/client', router)
  const state = mongoose.connection.readyState
  let permissions: string[] = []
  const token = (grants: string[]): string => {
    permissions = grants
    return sign({ id: '507f1f77bcf86cd799439011' }, process.env.JWT_SECRET ?? 'NOT_TOKEN_ENV')
  }
  before(() => { mongoose.connection.readyState = 1 })
  after(() => { mongoose.connection.readyState = state })
  beforeEach(() => {
    const active: unknown = { maxTimeMS: () => ({ lean: async () => ({ isActive: true, role: '507f1f77bcf86cd799439013' }) }) }
    const role: unknown = { maxTimeMS: () => ({ lean: async () => ({ isActive: true, name: 'Custom', permissions }) }) }
    const missing: unknown = { lean: async () => null }
    sinon.stub(UserModel, 'findById').returns(active as never)
    sinon.stub(RoleModel, 'findById').returns(role as never)
    sinon.stub(ClientModel, 'findById').returns(missing as never)
    sinon.stub(provider, 'geocode').throws(new Error('Provider must not be called'))
  })
  afterEach(() => { sinon.restore() })

  for (const path of ['/507f1f77bcf86cd799439012/geocode', '/507f1f77bcf86cd799439012/location-confirmation']) {
    it(`requires the location grant before ${path} reaches its handler`, async () => {
      expect((await request(app).post(`/client${path}`).send({})).status).to.equal(401)
      expect((await request(app).post(`/client${path}`).set('Authorization', `Bearer ${token(['manage_route_config'])}`).send({})).status).to.equal(403)
      expect((provider.geocode as sinon.SinonStub).called).to.equal(false)
      expect((ClientModel.findById as sinon.SinonStub).called).to.equal(false)
      expect((await request(app).post(`/client${path}`).set('Authorization', `Bearer ${token(['confirm_client_location'])}`).send({})).status).to.equal(path.endsWith('/geocode') ? 404 : 400)
    })
  }

  it('provides only a location snapshot to the confirmation grant', async () => {
    const path = '/client/507f1f77bcf86cd799439012/location-snapshot'
    expect((await request(app).get(path)).status).to.equal(401)
    expect((await request(app).get(path).set('Authorization', `Bearer ${token(['read_client'])}`)).status).to.equal(403)
    const find = ClientModel.findById as sinon.SinonStub
    expect(find.called).to.equal(false)
    find.returns({ lean: async () => ({ address: 'Old', lat: 1, lng: 2, nombreCompleto: 'Private', locationRevision: 3 }) })
    const response = await request(app).get(path).set('Authorization', `Bearer ${token(['confirm_client_location'])}`)
    expect(response.status).to.equal(200)
    expect(response.headers['cache-control']).to.equal('no-store')
    expect(response.body).to.deep.equal({ address: 'Old', lat: 1, lng: 2, locationRevision: 3 })
    expect(find.firstCall.args[1]).to.deep.equal({ _id: 0, address: 1, lat: 1, lng: 1, locationRevision: 1 })
    expect((await request(app).get('/client/507f1f77bcf86cd799439012').set('Authorization', `Bearer ${token(['confirm_client_location'])}`)).status).to.equal(403)
  })

  it('returns zero and nulls for legacy location fields and handles invalid or absent clients', async () => {
    const auth = `Bearer ${token(['confirm_client_location'])}`
    const find = ClientModel.findById as sinon.SinonStub
    find.returns({ lean: async () => ({}) })
    const path = '/client/507f1f77bcf86cd799439012/location-snapshot'
    expect((await request(app).get(path).set('Authorization', auth)).body).to.deep.equal({ address: null, lat: null, lng: null, locationRevision: 0 })
    expect((await request(app).get('/client/invalid/location-snapshot').set('Authorization', auth)).status).to.equal(400)
    find.returns({ lean: async () => null })
    expect((await request(app).get(path).set('Authorization', auth)).status).to.equal(404)
  })
})
