import { expect } from 'chai'
import mongoose from 'mongoose'
import request from 'supertest'

import CommercialFactModel from '../../src/models/commercialFact'
import SaleModel from '../../src/models/sale'
import UserModel from '../../src/models/user'
import { RoutePlanReaderDouble } from '../../src/services/commercialPorts'
import { buildMovements } from '../../src/services/cashflow'
import { generateToken } from '../../src/utils/jwt.handle'
import {
  PHASE0_CONTRACT_V1,
  resetPhase0ContractV1,
  seedPhase0ContractV1
} from '../fixtures/phase-0-contract-v1'

const TEST_DB_URI = 'mongodb://localhost:27017/gzapi_phase0_baseline_test'

describe('Phase 0 — baseline regression', () => {
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
      lines: [{ itemBuyId: ids.buyItem, productId: ids.product, quantity: buyQuantity }]
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
