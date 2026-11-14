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

  it('requires create and update grants for client mutations', async () => {
    const create = sinon.stub(ClientModel, 'create')
    const update = sinon.stub(ClientModel, 'updateOne')
    const id = '507f1f77bcf86cd799439012'
    expect((await request(app).post('/client').set('Authorization', `Bearer ${token(['read_client'])}`).send({ nombreCompleto: 'Test' })).status).to.equal(403)
    expect((await request(app).patch(`/client/${id}`).set('Authorization', `Bearer ${token(['read_client'])}`).send({ isActive: false })).status).to.equal(403)
    expect((await request(app).patch(`/client/${id}/managed`).set('Authorization', `Bearer ${token(['read_client'])}`).send({ isActive: false })).status).to.equal(403)
    expect(create.called).to.equal(false)
    expect(update.called).to.equal(false)
  })

  it('creates mobile-style clients active by default without overriding explicit false', async () => {
    const create = sinon.stub(ClientModel, 'create').callsFake(async (input: unknown) => new ClientModel(input) as never)
    const auth = `Bearer ${token(['create_client'])}`
    const mobile = await request(app).post('/client').set('Authorization', auth)
      .send({ nombreCompleto: 'Mobile client', address: '', telefonos: [], lat: null, lng: null, description: '' })
    const inactive = await request(app).post('/client').set('Authorization', auth)
      .send({ nombreCompleto: 'Inactive client', isActive: false })
    expect(mobile.status).to.equal(200)
    expect(mobile.body.isActive).to.equal(true)
    expect(inactive.status).to.equal(200)
    expect(inactive.body.isActive).to.equal(false)
    expect(create.callCount).to.equal(2)
  })

  it('returns validation errors without writing and preserves legacy location updates', async () => {
    const id = '507f1f77bcf86cd799439012'
    const update = sinon.stub(ClientModel, 'updateOne').resolves({ matchedCount: 1 } as never)
    const create = sinon.stub(ClientModel, 'create')
    expect((await request(app).post('/client').set('Authorization', `Bearer ${token(['create_client'])}`).send({ nombreCompleto: '  ' })).status).to.equal(400)
    expect((await request(app).patch(`/client/${id}`).set('Authorization', `Bearer ${token(['update_client'])}`).send({ telefonos: [-1] })).status).to.equal(400)
    expect(create.called).to.equal(false)
    expect(update.called).to.equal(false)
    const find = ClientModel.findById as sinon.SinonStub
    find.returns({ lean: async () => ({ address: 'Old', lat: 1, lng: 2, locationRevision: 0 }) })
    const payload = { nombreCompleto: 'Valid', address: 'New', lat: 1, lng: 2, telefonos: [] }
    expect((await request(app).patch(`/client/${id}`).set('Authorization', `Bearer ${token(['update_client'])}`).send(payload)).status).to.equal(200)
    const guarded = await request(app).patch(`/client/${id}/managed`).set('Authorization', `Bearer ${token(['update_client'])}`).send({ address: 'New', expectedFields: {} })
    expect(guarded.status).to.equal(409)
    expect(guarded.body.code).to.equal('CLIENT_LOCATION_CONFLICT')
    const variant = await request(app).patch(`/client/${id}/MANAGED/`).set('Authorization', `Bearer ${token(['update_client'])}`).send({ address: 'New', expectedFields: {} })
    expect(variant.status).to.equal(409)
    expect(update.calledOnce).to.equal(true)
  })

  it('returns conflict when managed contact data changed', async () => {
    const id = '507f1f77bcf86cd799439012'
    sinon.stub(ClientModel, 'updateOne').resolves({ matchedCount: 0 } as never)
    ;(ClientModel.findById as sinon.SinonStub).returns({ lean: async () => ({ nombreCompleto: 'Changed' }) })
    const result = await request(app).patch(`/client/${id}/managed`).set('Authorization', `Bearer ${token(['update_client'])}`)
      .send({ nombreCompleto: 'New', expectedFields: { nombreCompleto: 'Old' } })
    expect(result.status).to.equal(409)
    expect(result.body.code).to.equal('CLIENT_EDIT_CONFLICT')
  })

  it('returns 404 for missing clients on both contact-only update routes', async () => {
    const id = '507f1f77bcf86cd799439012'
    sinon.stub(ClientModel, 'updateOne').resolves({ matchedCount: 0 } as never)
    const auth = `Bearer ${token(['update_client'])}`
    for (const [path, body] of [[`/client/${id}`, { nombreCompleto: 'New' }], [`/client/${id}/managed`, { nombreCompleto: 'New', expectedFields: { nombreCompleto: 'Old' } }]] as const) {
      const result = await request(app).patch(path).set('Authorization', auth).send(body)
      expect(result.status).to.equal(404)
      expect(result.body.code).to.equal('CLIENT_NOT_FOUND')
    }
  })

  it('classifies combined update failures using the diagnostic read', async () => {
    const id = '507f1f77bcf86cd799439012'
    const original = { address: 'Old', lat: 1, lng: 2, locationRevision: 1, nombreCompleto: 'Old name' }
    const find = ClientModel.findById as sinon.SinonStub
    sinon.stub(ClientModel, 'updateOne').resolves({ matchedCount: 0 } as never)
    const auth = `Bearer ${token(['update_client'])}`
    const payload = { address: 'New', nombreCompleto: 'New name', expectedFields: { nombreCompleto: 'Old name' }, expectedLocation: { address: 'Old', lat: 1, lng: 2, locationRevision: 1 } }
    for (const [latest, status, code] of [
      [{ ...original, lat: 3, locationRevision: 2 }, 409, 'CLIENT_LOCATION_CONFLICT'],
      [{ ...original, nombreCompleto: 'Other' }, 409, 'CLIENT_EDIT_CONFLICT'],
      [{ ...original, lat: 3, locationRevision: 2, nombreCompleto: 'Other' }, 409, 'CLIENT_EDIT_CONFLICT'],
      [original, 409, 'CLIENT_EDIT_CONFLICT'],
      [null, 404, 'CLIENT_NOT_FOUND']
    ] as const) {
      find.resetHistory()
      find.onFirstCall().returns({ lean: async () => original })
      find.onSecondCall().returns({ lean: async () => latest })
      const result = await request(app).patch(`/client/${id}/managed`).set('Authorization', auth).send(payload)
      expect(result.status).to.equal(status)
      expect(result.body.code).to.equal(code)
    }
  })

  it('rejects invalid coordinate pairs on create and both update routes', async () => {
    const id = '507f1f77bcf86cd799439012'
    const create = sinon.stub(ClientModel, 'create')
    const write = sinon.stub(ClientModel, 'updateOne').resolves({ matchedCount: 1 } as never)
    const find = ClientModel.findById as sinon.SinonStub
    find.returns({ lean: async () => ({ address: 'Old', lat: 1, lng: 2, locationRevision: 0 }) })
    const createResult = await request(app).post('/client').set('Authorization', `Bearer ${token(['create_client'])}`).send({ nombreCompleto: 'Client', lat: 1 })
    expect(createResult.status).to.equal(400)
    const legacy = await request(app).patch(`/client/${id}`).set('Authorization', `Bearer ${token(['update_client'])}`).send({ lat: null })
    expect(legacy.status).to.equal(400)
    const managed = await request(app).patch(`/client/${id}/managed`).set('Authorization', `Bearer ${token(['update_client'])}`)
      .send({ lng: 181, expectedFields: {}, expectedLocation: { address: 'Old', lat: 1, lng: 2, locationRevision: 0 } })
    expect(managed.status).to.equal(400)
    for (const result of [createResult, legacy, managed]) expect(result.body.code).to.equal('INVALID_CLIENT_INPUT')
    expect(create.called).to.equal(false)
    expect(write.called).to.equal(false)
    const clear = await request(app).patch(`/client/${id}`).set('Authorization', `Bearer ${token(['update_client'])}`).send({ lat: null, lng: null })
    expect(clear.status).to.equal(200)
    expect(write.calledOnce).to.equal(true)
  })

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
