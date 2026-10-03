import { expect } from 'chai'
import mongoose from 'mongoose'
import request from 'supertest'
import sinon from 'sinon'
import express from 'express'

import CommercialFactModel from '../../src/models/commercialFact'
import RoleModel from '../../src/models/role'
import SaleModel from '../../src/models/sale'
import UserModel from '../../src/models/user'
import { generateToken } from '../../src/utils/jwt.handle'
import { correlationId } from '../../src/middleware/correlationId'
import { requestLogger } from '../../src/middleware/requestLogger'
import { sendErrorEnvelope } from '../../src/utils/error.handle'

const TEST_DB_URI = 'mongodb://localhost:27017/gzapi_phase0_auth_observability_test'
const BUSINESS_DATE = '2026-01-15T12:00:00Z'

describe('Phase 0 — auth and observability contract', () => {
  let app: Awaited<ReturnType<typeof import('../../src/app').createApp>>

  before(async () => {
    process.env.PHASE_0_CONTRACTS_ENABLED = 'true'
    await mongoose.connect(TEST_DB_URI)
    const { createApp } = await import('../../src/app')
    app = await createApp()
  })

  after(async () => {
    const dbName = mongoose.connection.db?.databaseName
    if (dbName?.endsWith('_test') === true) {
      await mongoose.connection.dropDatabase()
    }
    await mongoose.disconnect()
    delete process.env.PHASE_0_CONTRACTS_ENABLED
  })

  beforeEach(async () => {
    await CommercialFactModel.deleteMany({})
    await SaleModel.deleteMany({})
    await UserModel.deleteMany({})
    await RoleModel.deleteMany({})
  })

  const paymentPath = (saleId: string): string => `/commercialFact/sales/${saleId}/payment`
  const paymentBody = (): { businessDate: string, idempotencyKey: string } => ({ businessDate: BUSINESS_DATE, idempotencyKey: 'auth-observability-payment' })

  it('S-24a: missing JWT returns 401 AUTHENTICATION_INVALID before protected data changes', async () => {
    const sale = await SaleModel.create({ estado: 'Pendiente', total: 1000, user: new mongoose.Types.ObjectId() })

    const res = await request(app).post(paymentPath(String(sale._id))).send(paymentBody())

    expect(res.status).to.equal(401)
    expect(res.body.code).to.equal('AUTHENTICATION_INVALID')
    expect(res.body.message).to.be.a('string')
    expect(res.body.correlationId).to.match(/^[A-Za-z0-9_-]+$/)
    expect(await CommercialFactModel.countDocuments({})).to.equal(0)
  })

  it('S-24b: invalid JWT returns 401 AUTHENTICATION_INVALID with the supplied correlation ID', async () => {
    const sale = await SaleModel.create({ estado: 'Pendiente', total: 1000, user: new mongoose.Types.ObjectId() })

    const res = await request(app)
      .post(paymentPath(String(sale._id)))
      .set('Authorization', 'Bearer not-a-jwt')
      .set('x-correlation-id', 'client-correlation-42')
      .send(paymentBody())

    expect(res.status).to.equal(401)
    expect(res.body).to.deep.include({
      code: 'AUTHENTICATION_INVALID',
      correlationId: 'client-correlation-42'
    })
    expect(await CommercialFactModel.countDocuments({})).to.equal(0)
  })

  it('rejects an unsafe supplied correlation ID and generates a bounded replacement', async () => {
    const sale = await SaleModel.create({ estado: 'Pendiente', total: 1000, user: new mongoose.Types.ObjectId() })

    const res = await request(app)
      .post(paymentPath(String(sale._id)))
      .set('x-correlation-id', 'unsafe correlation id')
      .send(paymentBody())

    expect(res.status).to.equal(401)
    expect(res.body.correlationId).to.match(/^[A-Za-z0-9_-]+$/)
    expect(res.body.correlationId).to.not.equal('unsafe correlation id')
  })

  it('S-20: a valid JWT without the operation permission returns 403 PERMISSION_DENIED', async () => {
    const role = await RoleModel.create({ name: 'Repartidor', permissions: [], isActive: true })
    const user = await UserModel.create({
      nickname: 'observability-delivery-user',
      password: 'not-a-real-password',
      role: role._id,
      isActive: true
    })
    const token = await generateToken(user)
    const sale = await SaleModel.create({ estado: 'Pendiente', total: 1000, user: new mongoose.Types.ObjectId() })

    const res = await request(app)
      .post(paymentPath(String(sale._id)))
      .set('Authorization', `Bearer ${token}`)
      .send(paymentBody())

    expect(res.status).to.equal(403)
    expect(res.body.code).to.equal('PERMISSION_DENIED')
    expect(res.body.correlationId).to.match(/^[A-Za-z0-9_-]+$/)
    expect(await CommercialFactModel.countDocuments({})).to.equal(0)
  })

  it('NFR-004: request logs retain correlation while redacting authorization, cookies, passwords, and JWT-like values', async () => {
    const logger = sinon.stub(console, 'log')
    const testApp = express()
    testApp.use(express.json())
    testApp.use(correlationId)
    testApp.use(requestLogger)
    testApp.post('/redaction-check', (req, res) => {
      sendErrorEnvelope(res, 401, 'AUTHENTICATION_INVALID', 'Authentication is invalid', res.locals.correlationId)
    })

    try {
      const res = await request(testApp)
        .post('/redaction-check?token=header.payload.signature')
        .set('Authorization', 'Bearer header.payload.signature')
        .set('Cookie', 'session=header.payload.signature')
        .set('x-correlation-id', 'logging-correlation-7')
        .send({ password: 'secret-password', nested: { jwt: 'header.payload.signature' } })

      expect(res.status).to.equal(401)
      expect(res.body.correlationId).to.equal('logging-correlation-7')

      const output = logger.getCalls().map((call) => call.args.join(' ')).join('\n')
      expect(output).to.contain('logging-correlation-7')
      expect(output).to.not.contain('secret-password')
      expect(output).to.not.contain('header.payload.signature')
      expect(output).to.not.contain('Authorization')
      expect(output).to.not.contain('Cookie')
    } finally {
      logger.restore()
    }
  })
})
