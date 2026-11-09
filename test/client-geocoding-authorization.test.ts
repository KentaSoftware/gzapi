import express from 'express'
import { expect } from 'chai'
import mongoose from 'mongoose'
import { sign } from 'jsonwebtoken'
import sinon from 'sinon'
import request from 'supertest'
import UserModel from '../src/models/user'
import ClientModel from '../src/models/client'
import * as provider from '../src/services/geocodingProvider'
import { router } from '../src/routes/client'

describe('client location authorization', () => {
  const app = express().use(express.json()).use('/client', router)
  const state = mongoose.connection.readyState
  const token = (permissions: string[]): string => sign({ id: '507f1f77bcf86cd799439011', role: { name: 'Custom', permissions } }, process.env.JWT_SECRET ?? 'NOT_TOKEN_ENV')
  before(() => { mongoose.connection.readyState = 1 })
  after(() => { mongoose.connection.readyState = state })
  beforeEach(() => {
    const active: unknown = { maxTimeMS: () => ({ lean: async () => ({ isActive: true }) }) }
    const missing: unknown = { lean: async () => null }
    sinon.stub(UserModel, 'findById').returns(active as never)
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
})
