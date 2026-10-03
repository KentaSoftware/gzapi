import { expect } from 'chai'
import mongoose from 'mongoose'
import request from 'supertest'

import SaleModel from '../../src/models/sale'
import CommercialFactModel from '../../src/models/commercialFact'
import RoleModel from '../../src/models/role'
import UserModel from '../../src/models/user'
import { generateToken } from '../../src/utils/jwt.handle'

const TEST_DB_URI = 'mongodb://localhost:27017/gzapi_phase0_commercialfact_controller_test'

const BUSINESS_DATE = '2026-01-15T12:00:00Z'
const ADMIN_PERMISSIONS = [
  'confirm_sale_payment',
  'refund_sale',
  'confirm_purchase_payment',
  'receive_purchase',
  'adjust_stock',
  'read_route_plan'
]

describe('Phase 0 — commercial fact controller', () => {
  let app: Awaited<ReturnType<typeof import('../../src/app').createApp>>
  let role: any
  let user: any
  let token: string

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
    process.env.PHASE_0_CONTRACTS_ENABLED = 'true'
    await CommercialFactModel.deleteMany({})
    await SaleModel.deleteMany({})
    await UserModel.deleteMany({})
    await RoleModel.deleteMany({})

    role = await RoleModel.create({
      name: 'Administración',
      permissions: ADMIN_PERMISSIONS,
      isActive: true
    })
    user = await UserModel.create({
      nickname: 'controller-admin',
      password: 'not-a-real-password',
      role: role._id,
      isActive: true
    })
    token = await generateToken(user)
  })

  const authed = (method: 'post', path: string, body: object): request.Test =>
    request(app)[method](path)
      .set('Authorization', `Bearer ${token}`)
      .send(body)

  const createSale = async (total: number): Promise<any> => {
    return await SaleModel.create({ estado: 'Pendiente', total, user: new mongoose.Types.ObjectId() })
  }

  describe('sale payment', () => {
    it('S-01: confirming a full sale payment before delivery records the cash entry and no delivery', async () => {
      const sale = await createSale(1000)

      const first = await authed('post', `/commercialFact/sales/${String(sale._id)}/payment`, {
        businessDate: BUSINESS_DATE,
        idempotencyKey: 'pay-1'
      })

      expect(first.status).to.equal(201)
      expect(first.body.replayed).to.equal(false)
      expect(first.body.fact.type).to.equal('SALE_PAYMENT')

      const stored = await SaleModel.findById(sale._id).lean()
      expect(stored.paidAt).to.deep.equal(new Date(BUSINESS_DATE))

      const deliveryCount = await CommercialFactModel.countDocuments({ type: 'SALE_DELIVERY', aggregateId: String(sale._id) })
      expect(deliveryCount).to.equal(0)

      // S-26 semantics at HTTP level: an idempotent replay returns 200 with replayed: true
      const replay = await authed('post', `/commercialFact/sales/${String(sale._id)}/payment`, {
        businessDate: BUSINESS_DATE,
        idempotencyKey: 'pay-1'
      })

      expect(replay.status).to.equal(200)
      expect(replay.body.replayed).to.equal(true)
      expect(replay.body.fact._id).to.equal(first.body.fact._id)

      const paymentCount = await CommercialFactModel.countDocuments({ type: 'SALE_PAYMENT', aggregateId: String(sale._id) })
      expect(paymentCount).to.equal(1)
    })
  })

  describe('sale delivery', () => {
    it('S-29: registering a delivery keeps a traceable fact and creates no cash movement', async () => {
      const sale = await createSale(1000)

      await authed('post', `/commercialFact/sales/${String(sale._id)}/payment`, {
        businessDate: BUSINESS_DATE,
        idempotencyKey: 'pay-1'
      })

      const delivery = await authed('post', `/commercialFact/sales/${String(sale._id)}/delivery`, {
        businessDate: BUSINESS_DATE,
        idempotencyKey: 'deliver-1'
      })

      expect(delivery.status).to.equal(201)
      expect(delivery.body.replayed).to.equal(false)
      expect(delivery.body.fact.type).to.equal('SALE_DELIVERY')

      const deliveryCount = await CommercialFactModel.countDocuments({ type: 'SALE_DELIVERY', aggregateId: String(sale._id) })
      expect(deliveryCount).to.equal(1)

      // Delivery must not create a second payment fact nor alter the paid projection.
      const paymentCount = await CommercialFactModel.countDocuments({ type: 'SALE_PAYMENT', aggregateId: String(sale._id) })
      expect(paymentCount).to.equal(1)
      const stored = await SaleModel.findById(sale._id).lean()
      expect(stored.paidAt).to.deep.equal(new Date(BUSINESS_DATE))
    })

    it('S-29a: a delivery before payment is recorded and payment still completes afterwards', async () => {
      const sale = await createSale(1000)

      const delivery = await authed('post', `/commercialFact/sales/${String(sale._id)}/delivery`, {
        businessDate: BUSINESS_DATE,
        idempotencyKey: 'deliver-a'
      })
      expect(delivery.status).to.equal(201)

      const payment = await authed('post', `/commercialFact/sales/${String(sale._id)}/payment`, {
        businessDate: BUSINESS_DATE,
        idempotencyKey: 'pay-a'
      })
      expect(payment.status).to.equal(201)

      const deliveryCount = await CommercialFactModel.countDocuments({ type: 'SALE_DELIVERY', aggregateId: String(sale._id) })
      const paymentCount = await CommercialFactModel.countDocuments({ type: 'SALE_PAYMENT', aggregateId: String(sale._id) })
      expect(deliveryCount).to.equal(1)
      expect(paymentCount).to.equal(1)
    })

    it('S-29b: a delivery after payment creates no cash movement', async () => {
      const sale = await createSale(1000)

      await authed('post', `/commercialFact/sales/${String(sale._id)}/payment`, {
        businessDate: BUSINESS_DATE,
        idempotencyKey: 'pay-b'
      })

      const delivery = await authed('post', `/commercialFact/sales/${String(sale._id)}/delivery`, {
        businessDate: BUSINESS_DATE,
        idempotencyKey: 'deliver-b'
      })
      expect(delivery.status).to.equal(201)

      const paymentCount = await CommercialFactModel.countDocuments({ type: 'SALE_PAYMENT', aggregateId: String(sale._id) })
      expect(paymentCount).to.equal(1)
    })
  })

  describe('sale cancellation', () => {
    it('S-30: cancelling a paid sale preserves the original payment', async () => {
      const sale = await createSale(1000)

      await authed('post', `/commercialFact/sales/${String(sale._id)}/payment`, {
        businessDate: BUSINESS_DATE,
        idempotencyKey: 'pay-1'
      })

      const cancellation = await authed('post', `/commercialFact/sales/${String(sale._id)}/cancellation`, {
        businessDate: BUSINESS_DATE,
        idempotencyKey: 'cancel-1'
      })

      expect(cancellation.status).to.equal(201)
      expect(cancellation.body.fact.type).to.equal('SALE_CANCELLATION')

      const paymentCount = await CommercialFactModel.countDocuments({ type: 'SALE_PAYMENT', aggregateId: String(sale._id) })
      expect(paymentCount).to.equal(1)
      const stored = await SaleModel.findById(sale._id).lean()
      expect(stored.paidAt).to.deep.equal(new Date(BUSINESS_DATE))
    })

    it('S-30a: cancelling a paid, not-yet-delivered sale preserves the original payment', async () => {
      const sale = await createSale(1000)

      await authed('post', `/commercialFact/sales/${String(sale._id)}/payment`, {
        businessDate: BUSINESS_DATE,
        idempotencyKey: 'pay-a'
      })

      const cancellation = await authed('post', `/commercialFact/sales/${String(sale._id)}/cancellation`, {
        businessDate: BUSINESS_DATE,
        idempotencyKey: 'cancel-a'
      })
      expect(cancellation.status).to.equal(201)

      const paymentCount = await CommercialFactModel.countDocuments({ type: 'SALE_PAYMENT', aggregateId: String(sale._id) })
      expect(paymentCount).to.equal(1)
    })

    it('S-30b: cancelling a delivered, paid sale preserves the original payment', async () => {
      const sale = await createSale(1000)

      await authed('post', `/commercialFact/sales/${String(sale._id)}/payment`, {
        businessDate: BUSINESS_DATE,
        idempotencyKey: 'pay-b'
      })
      await authed('post', `/commercialFact/sales/${String(sale._id)}/delivery`, {
        businessDate: BUSINESS_DATE,
        idempotencyKey: 'deliver-b'
      })

      const cancellation = await authed('post', `/commercialFact/sales/${String(sale._id)}/cancellation`, {
        businessDate: BUSINESS_DATE,
        idempotencyKey: 'cancel-b'
      })
      expect(cancellation.status).to.equal(201)

      const paymentCount = await CommercialFactModel.countDocuments({ type: 'SALE_PAYMENT', aggregateId: String(sale._id) })
      expect(paymentCount).to.equal(1)
    })
  })

  describe('physical return', () => {
    it('S-31: a physical return delegates to Stock and creates no refund', async () => {
      const sale = await createSale(1000)

      await authed('post', `/commercialFact/sales/${String(sale._id)}/delivery`, {
        businessDate: BUSINESS_DATE,
        idempotencyKey: 'deliver-1'
      })

      const physicalReturn = await authed('post', `/commercialFact/sales/${String(sale._id)}/physical-return`, {
        lines: [{ quantity: 3 }],
        businessDate: BUSINESS_DATE,
        idempotencyKey: 'return-1'
      })

      expect(physicalReturn.status).to.equal(201)
      expect(physicalReturn.body.fact.type).to.equal('SALE_PHYSICAL_RETURN')

      const refundCount = await CommercialFactModel.countDocuments({ type: 'SALE_REFUND', aggregateId: String(sale._id) })
      expect(refundCount).to.equal(0)
    })

    it('S-31a: a full physical return delegates to Stock and creates no refund', async () => {
      const sale = await createSale(1000)

      await authed('post', `/commercialFact/sales/${String(sale._id)}/delivery`, {
        businessDate: BUSINESS_DATE,
        idempotencyKey: 'deliver-a'
      })

      const physicalReturn = await authed('post', `/commercialFact/sales/${String(sale._id)}/physical-return`, {
        lines: [{ quantity: 3 }, { quantity: 2 }],
        businessDate: BUSINESS_DATE,
        idempotencyKey: 'return-a'
      })
      expect(physicalReturn.status).to.equal(201)
      expect(physicalReturn.body.fact.type).to.equal('SALE_PHYSICAL_RETURN')

      const refundCount = await CommercialFactModel.countDocuments({ type: 'SALE_REFUND', aggregateId: String(sale._id) })
      expect(refundCount).to.equal(0)
    })

    it('S-31b: a partial physical return delegates to Stock and creates no refund', async () => {
      const sale = await createSale(1000)

      await authed('post', `/commercialFact/sales/${String(sale._id)}/delivery`, {
        businessDate: BUSINESS_DATE,
        idempotencyKey: 'deliver-b'
      })

      const physicalReturn = await authed('post', `/commercialFact/sales/${String(sale._id)}/physical-return`, {
        lines: [{ quantity: 1 }],
        businessDate: BUSINESS_DATE,
        idempotencyKey: 'return-b'
      })
      expect(physicalReturn.status).to.equal(201)
      expect(physicalReturn.body.fact.type).to.equal('SALE_PHYSICAL_RETURN')

      const refundCount = await CommercialFactModel.countDocuments({ type: 'SALE_REFUND', aggregateId: String(sale._id) })
      expect(refundCount).to.equal(0)
    })
  })

  describe('flag gate', () => {
    it('with PHASE_0_CONTRACTS_ENABLED false every contractual endpoint responds 503 FEATURE_UNAVAILABLE with no state change', async () => {
      const sale = await createSale(1000)
      const buyId = String(new mongoose.Types.ObjectId())

      const cases = [
        { path: `/commercialFact/sales/${String(sale._id)}/payment`, body: { businessDate: BUSINESS_DATE, idempotencyKey: 'fg-1' } },
        { path: `/commercialFact/sales/${String(sale._id)}/refunds`, body: { amount: 10, businessDate: BUSINESS_DATE, reason: 'r', idempotencyKey: 'fg-2' } },
        { path: `/commercialFact/buys/${buyId}/payment`, body: { businessDate: BUSINESS_DATE, idempotencyKey: 'fg-3' } },
        { path: `/commercialFact/buys/${buyId}/receipt`, body: { lines: [{ quantity: 1 }], businessDate: BUSINESS_DATE, idempotencyKey: 'fg-4' } },
        { path: `/commercialFact/buys/${buyId}/adjustments`, body: { sourceFactId: 'x', lines: [{ quantity: -1 }], reason: 'r', businessDate: BUSINESS_DATE, idempotencyKey: 'fg-5' } },
        { path: `/commercialFact/sales/${String(sale._id)}/delivery`, body: { businessDate: BUSINESS_DATE, idempotencyKey: 'fg-6' } },
        { path: `/commercialFact/sales/${String(sale._id)}/cancellation`, body: { businessDate: BUSINESS_DATE, idempotencyKey: 'fg-7' } },
        { path: `/commercialFact/sales/${String(sale._id)}/physical-return`, body: { lines: [{ quantity: 1 }], businessDate: BUSINESS_DATE, idempotencyKey: 'fg-8' } }
      ]

      process.env.PHASE_0_CONTRACTS_ENABLED = 'false'
      try {
        for (const item of cases) {
          const res = await authed('post', item.path, item.body)
          expect(res.status).to.equal(503)
          expect(res.body.code).to.equal('FEATURE_UNAVAILABLE')
        }
      } finally {
        process.env.PHASE_0_CONTRACTS_ENABLED = 'true'
      }

      const factCount = await CommercialFactModel.countDocuments({})
      expect(factCount).to.equal(0)
      const stored = await SaleModel.findById(sale._id).lean()
      expect(stored.paidAt).to.equal(undefined)
    })
  })

  describe('auth denial', () => {
    it('a request without a JWT is rejected before protected data is touched', async () => {
      const sale = await createSale(1000)

      const res = await request(app)
        .post(`/commercialFact/sales/${String(sale._id)}/payment`)
        .send({ businessDate: BUSINESS_DATE, idempotencyKey: 'no-jwt-1' })

      expect(res.status).to.be.oneOf([400, 401])
      expect(res.status).to.not.equal(201)

      const paymentCount = await CommercialFactModel.countDocuments({ type: 'SALE_PAYMENT', aggregateId: String(sale._id) })
      expect(paymentCount).to.equal(0)
    })
  })
})
