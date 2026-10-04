import { expect } from 'chai'
import mongoose from 'mongoose'
import request from 'supertest'

import CommercialFactModel from '../../src/models/commercialFact'
import UserModel from '../../src/models/user'
import SaleModel from '../../src/models/sale'
import { generateToken } from '../../src/utils/jwt.handle'
import {
  PHASE0_CONTRACT_V1,
  resetPhase0ContractV1,
  seedPhase0ContractV1
} from '../fixtures/phase-0-contract-v1'

const TEST_DB_URI = 'mongodb://localhost:27017/gzapi_phase0_rbac_test'

describe('Phase 0 — RBAC contract', () => {
  let app: Awaited<ReturnType<typeof import('../../src/app').createApp>>
  let tokens: Record<string, string>

  before(async () => {
    process.env.PHASE_0_CONTRACTS_ENABLED = 'true'
    await mongoose.connect(TEST_DB_URI)
    const { createApp } = await import('../../src/app')
    app = await createApp()
  })

  after(async () => {
    await resetPhase0ContractV1()
    const dbName = mongoose.connection.db?.databaseName
    if (dbName?.endsWith('_test') === true) await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
    delete process.env.PHASE_0_CONTRACTS_ENABLED
  })

  beforeEach(async () => {
    const fixture = await seedPhase0ContractV1()
    const users = await UserModel.find({ _id: { $in: Object.values(fixture.ids).slice(4, 8) } })
    tokens = {}
    for (const user of users) tokens[user.nickname] = await generateToken(user)
  })

  const post = (token: string, path: string, body: object): request.Test => request(app)
    .post(path)
    .set('Authorization', `Bearer ${token}`)
    .send(body)

  it('S-05a: a Preventista confirms payment for their own undelivered sale', async () => {
    const { ids, businessDate } = PHASE0_CONTRACT_V1
    const response = await post(tokens['fixture-salesperson'], `/commercialFact/sales/${ids.sale}/payment`, {
      businessDate,
      idempotencyKey: 'own-sale-payment'
    })

    expect(response.status).to.equal(201)
    expect(response.body.fact.actorId).to.equal(ids.salespersonUser)
  })

  it('S-05b: a Preventista confirms payment for their own delivered sale', async () => {
    const { ids, businessDate } = PHASE0_CONTRACT_V1
    const delivery = await post(tokens['fixture-salesperson'], `/commercialFact/sales/${ids.sale}/delivery`, {
      businessDate,
      idempotencyKey: 'own-sale-delivery'
    })
    expect(delivery.status).to.equal(201)

    const payment = await post(tokens['fixture-salesperson'], `/commercialFact/sales/${ids.sale}/payment`, {
      businessDate,
      idempotencyKey: 'own-delivered-sale-payment'
    })

    expect(payment.status).to.equal(201)
    expect(payment.body.fact.actorId).to.equal(ids.salespersonUser)
  })

  it('S-05 ownership denial: a Preventista cannot mutate another user’s sale', async () => {
    const { ids, businessDate } = PHASE0_CONTRACT_V1
    const response = await post(tokens['fixture-salesperson'], `/commercialFact/sales/${ids.otherSale}/payment`, {
      businessDate,
      idempotencyKey: 'other-sale-payment'
    })

    expect(response.status).to.equal(403)
    expect(response.body.code).to.equal('SALE_PAYMENT_FORBIDDEN')
    expect(await CommercialFactModel.countDocuments({ aggregateId: ids.otherSale })).to.equal(0)
  })

  it('S-08a: Administración confirms payment for a sale created by a Preventista', async () => {
    const { ids, businessDate } = PHASE0_CONTRACT_V1
    const response = await post(tokens['fixture-admin'], `/commercialFact/sales/${ids.sale}/payment`, {
      businessDate,
      idempotencyKey: 'admin-sale-payment'
    })

    expect(response.status).to.equal(201)
    expect(response.body.fact.actorId).to.equal(ids.adminUser)
  })

  it('S-08b: Administración confirms payment for a sale created by Administración', async () => {
    const { ids, businessDate, saleTotal } = PHASE0_CONTRACT_V1
    const sale = await SaleModel.create({
      estado: 'Pendiente',
      total: saleTotal,
      user: ids.adminUser
    })

    const response = await post(tokens['fixture-admin'], `/commercialFact/sales/${String(sale._id)}/payment`, {
      businessDate,
      idempotencyKey: 'admin-created-sale-payment'
    })

    expect(response.status).to.equal(201)
    expect(response.body.fact.actorId).to.equal(ids.adminUser)
  })

  it('S-20/S-20a: Repartidor and Preventista are denied a refund without a financial mutation', async () => {
    const { ids, businessDate } = PHASE0_CONTRACT_V1
    const body = {
      amount: 100,
      businessDate,
      reason: 'not permitted',
      idempotencyKey: 'denied-refund'
    }

    const salesperson = await post(tokens['fixture-salesperson'], `/commercialFact/sales/${ids.sale}/refunds`, body)
    const driver = await post(tokens['fixture-driver'], `/commercialFact/sales/${ids.sale}/refunds`, body)

    expect(salesperson.body.code).to.equal('PERMISSION_DENIED')
    expect(driver.body.code).to.equal('PERMISSION_DENIED')
    expect(await CommercialFactModel.countDocuments({ type: 'SALE_REFUND' })).to.equal(0)
  })

  it('S-25a: a Preventista cannot adjust Stock after a complete purchase receipt', async () => {
    const { ids, businessDate, buyQuantity } = PHASE0_CONTRACT_V1
    const receipt = await post(tokens['fixture-admin'], `/commercialFact/buys/${ids.buy}/receipt`, {
      businessDate,
      idempotencyKey: 'receipt-before-denied-adjustment',
      lines: [{ quantity: buyQuantity }]
    })
    expect(receipt.status).to.equal(201)

    const response = await post(tokens['fixture-salesperson'], `/commercialFact/buys/${ids.buy}/adjustments`, {
      sourceFactId: receipt.body.fact._id,
      lines: [{ quantity: -1 }],
      reason: 'not permitted',
      businessDate,
      idempotencyKey: 'denied-adjustment'
    })

    expect(response.status).to.equal(403)
    expect(response.body.code).to.equal('PERMISSION_DENIED')
    expect(await CommercialFactModel.countDocuments({ type: 'PURCHASE_ADJUSTMENT' })).to.equal(0)
  })
})
