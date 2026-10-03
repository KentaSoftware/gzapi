const { expect } = require('chai')
const mongoose = require('mongoose')
const request = require('supertest')

const CommercialFactModel = require('../../src/models/commercialFact').default
const SaleModel = require('../../src/models/sale').default
const UserModel = require('../../src/models/user').default
const { RoutePlanReaderDouble } = require('../../src/services/commercialPorts')
const { buildMovements } = require('../../src/services/cashflow')
const { generateToken } = require('../../src/utils/jwt.handle')
const {
  PHASE0_CONTRACT_V1,
  resetPhase0ContractV1,
  seedPhase0ContractV1
} = require('../fixtures/phase-0-contract-v1')

const TEST_DB_URI = 'mongodb://localhost:27017/gzapi_phase0_baseline_test'

describe('Phase 0 — baseline regression', () => {
  let app
  let tokens

  before(async () => {
    process.env.PHASE_0_CONTRACTS_ENABLED = 'true'
    await mongoose.connect(TEST_DB_URI)
    const { createApp } = require('../../src/app')
    app = await createApp()
  })

  after(async () => {
    await resetPhase0ContractV1()
    const dbName = mongoose.connection.db && mongoose.connection.db.databaseName
    if (dbName && dbName.endsWith('_test')) await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
    delete process.env.PHASE_0_CONTRACTS_ENABLED
  })

  beforeEach(async () => {
    const fixture = await seedPhase0ContractV1()
    const users = await UserModel.find({ _id: { $in: Object.values(fixture.ids).slice(4, 8) } })
    tokens = {}
    for (const user of users) tokens[user.nickname] = await generateToken(user)
  })

  const post = (token, path, body) => request(app)
    .post(path)
    .set('Authorization', `Bearer ${token}`)
    .send(body)

  it('S-17: phase-0-contract-v1 baseline proves payment, receipt, denial, and read-only route contracts', async () => {
    const { ids, businessDate, buyQuantity } = PHASE0_CONTRACT_V1
    expect(PHASE0_CONTRACT_V1.version).to.equal('phase-0-contract-v1')

    const unpaidSale = await SaleModel.findById(ids.sale).lean()
    const period = { startDate: new Date('2026-01-01T00:00:00.000Z'), endDate: new Date('2026-01-31T23:59:59.999Z') }
    expect(buildMovements({ sales: [unpaidSale], buys: [], expenses: [] }, period)).to.deep.equal([])

    const salePayment = await post(tokens['fixture-salesperson'], `/commercialFact/sales/${ids.sale}/payment`, {
      businessDate,
      idempotencyKey: 'baseline-sale-payment'
    })
    expect(salePayment.status).to.equal(201)
    expect(salePayment.body.fact.type).to.equal('SALE_PAYMENT')
    const paidSale = await SaleModel.findById(ids.sale).lean()
    expect(buildMovements({ sales: [paidSale], buys: [], expenses: [] }, period)).to.have.length(1)

    const buyPayment = await post(tokens['fixture-admin'], `/commercialFact/buys/${ids.buy}/payment`, {
      businessDate,
      idempotencyKey: 'baseline-buy-payment'
    })
    expect(buyPayment.status).to.equal(201)
    expect(buyPayment.body.fact.type).to.equal('PURCHASE_PAYMENT')

    const receipt = await post(tokens['fixture-admin'], `/commercialFact/buys/${ids.buy}/receipt`, {
      businessDate,
      idempotencyKey: 'baseline-buy-receipt',
      lines: [{ quantity: buyQuantity }]
    })
    expect(receipt.status).to.equal(201)
    expect(receipt.body.fact.type).to.equal('PURCHASE_RECEIPT')

    const deniedRefund = await post(tokens['fixture-driver'], `/commercialFact/sales/${ids.sale}/refunds`, {
      amount: 100,
      businessDate,
      reason: 'not allowed',
      idempotencyKey: 'baseline-denied-refund'
    })
    expect(deniedRefund.status).to.equal(403)
    expect(deniedRefund.body.code).to.equal('PERMISSION_DENIED')
    expect(await CommercialFactModel.countDocuments({ type: 'SALE_REFUND' })).to.equal(0)

    const reader = new RoutePlanReaderDouble({ baseline: { planId: 'baseline', stops: ['Depot'] } })
    const plan = await reader.readSavedPlan('baseline')
    expect(Object.isFrozen(plan)).to.equal(true)
  })
})
