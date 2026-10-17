import { expect } from 'chai'
import mongoose from 'mongoose'
import request from 'supertest'

import UserModel from '../../src/models/user'
import { generateToken } from '../../src/utils/jwt.handle'
import {
  PHASE0_CONTRACT_V1,
  resetPhase0ContractV1,
  seedPhase0ContractV1
} from '../fixtures/phase-0-contract-v1'

const TEST_DB_URI = 'mongodb://localhost:27017/gzapi_phase0_performance_test'
const WARM_UPS = 5
const SAMPLES = 50
const P95_LIMIT_MS = 5000

const percentile95 = (samples: number[]): number => {
  const ordered = [...samples].sort((left, right) => left - right)
  return ordered[Math.ceil(ordered.length * 0.95) - 1]
}

describe('Phase 0 — local performance measurement', () => {
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

  const prepareFixture = async (): Promise<any> => {
    const fixture = await seedPhase0ContractV1()
    const users = await UserModel.find({ _id: { $in: Object.values(fixture.ids).slice(4, 8) } })
    tokens = {}
    for (const user of users) tokens[user.nickname] = await generateToken(user)
    return fixture
  }

  const post = async (token: string, path: string, body: object): Promise<request.Response> =>
    await new Promise((resolve, reject) => {
      void request(app)
        .post(path)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .end((error, response) => {
          if (error != null) reject(error)
          else resolve(response)
        })
    })

  const measure = async (
    operation: string,
    prepare: () => Promise<unknown>,
    execute: () => Promise<request.Response>
  ): Promise<number> => {
    for (let index = 0; index < WARM_UPS; index += 1) {
      await prepare()
      const warmUp = await execute()
      expect(warmUp.status).to.be.oneOf([201, 403])
    }

    const samples: number[] = []
    for (let index = 0; index < SAMPLES; index += 1) {
      await prepare()
      const startedAt = process.hrtime.bigint()
      const response = await execute()
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
      expect(response.status).to.be.oneOf([201, 403])
      samples.push(elapsedMs)
    }

    const p95 = percentile95(samples)
    expect(p95, `${operation} p95 was ${p95.toFixed(2)}ms`).to.be.at.most(P95_LIMIT_MS)
    return p95
  }

  it('NFR-002: local Mongo p95 is at most 5s after five warm-ups and fifty samples per operation', async function () {
    this.timeout(60000)

    const p95 = {}
    p95.salePayment = await measure('sale payment', prepareFixture, async () => {
      const { ids, businessDate } = PHASE0_CONTRACT_V1
      return await post(tokens['fixture-salesperson'], `/commercialFact/sales/${ids.sale}/payment`, {
        businessDate,
        idempotencyKey: 'performance-sale-payment'
      })
    })

    p95.saleRefund = await measure('sale refund', prepareFixture, async () => {
      const { ids, businessDate } = PHASE0_CONTRACT_V1
      const payment = await post(tokens['fixture-admin'], `/commercialFact/sales/${ids.sale}/payment`, {
        businessDate,
        idempotencyKey: 'performance-refund-payment'
      })
      expect(payment.status).to.equal(201)
      return await post(tokens['fixture-admin'], `/commercialFact/sales/${ids.sale}/refunds`, {
        amount: 100,
        businessDate,
        reason: 'performance measurement',
        idempotencyKey: 'performance-sale-refund'
      })
    })

    p95.purchasePayment = await measure('purchase payment', prepareFixture, async () => {
      const { ids, businessDate } = PHASE0_CONTRACT_V1
      return await post(tokens['fixture-admin'], `/commercialFact/buys/${ids.buy}/payment`, {
        businessDate,
        idempotencyKey: 'performance-purchase-payment'
      })
    })

    p95.purchaseReceipt = await measure('purchase receipt', prepareFixture, async () => {
      const { ids, businessDate, buyQuantity } = PHASE0_CONTRACT_V1
      return await post(tokens['fixture-admin'], `/commercialFact/buys/${ids.buy}/receipt`, {
        businessDate,
        idempotencyKey: 'performance-purchase-receipt',
        lines: [{ itemBuyId: ids.buyItem, productId: ids.product, quantity: buyQuantity }]
      })
    })

    p95.deniedRefund = await measure('denied refund', prepareFixture, async () => {
      const { ids, businessDate } = PHASE0_CONTRACT_V1
      return await post(tokens['fixture-driver'], `/commercialFact/sales/${ids.sale}/refunds`, {
        amount: 100,
        businessDate,
        reason: 'performance measurement',
        idempotencyKey: 'performance-denied-refund'
      })
    })

    console.log(`NFR-002 p95 milliseconds: ${JSON.stringify(p95)}`)
  })
})
