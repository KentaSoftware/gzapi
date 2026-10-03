const { expect } = require('chai')
const sinon = require('sinon')
const mongoose = require('mongoose')

const SaleModel = require('../../src/models/sale').default
const BuyModel = require('../../src/models/buy').default
const ItemBuyModel = require('../../src/models/itemBuy').default
const CommercialFactModel = require('../../src/models/commercialFact').default
const { CommercialFactService } = require('../../src/services/commercialFact')
const { CommercialFactError } = require('../../src/interfaces/commercialFact.interface')
const { financePortAdapter } = require('../../src/services/commercialPorts')

const TEST_DB_URI = 'mongodb://localhost:27017/gzapi_phase0_commercialfact_test'

let spyStockPort

const makeService = () => new CommercialFactService({ stockPort: spyStockPort })

const captureError = async (promise) => {
  try {
    await promise
    return undefined
  } catch (error) {
    return error
  }
}

const createSale = async (total) =>
  SaleModel.create({ estado: 'Pendiente', total, user: new mongoose.Types.ObjectId() })

const createBuy = async (total) =>
  BuyModel.create({ estado: 'Pendiente', total, user: new mongoose.Types.ObjectId() })

const createBuyWithItems = async (total, cantidad) => {
  const buy = await createBuy(total)
  await ItemBuyModel.create({
    idBuy: buy._id,
    idProducto: new mongoose.Types.ObjectId(),
    cantidad,
    total,
    precio: 40,
    estado: true
  })
  return buy
}

const cancelBuy = async (buyId) =>
  BuyModel.updateOne({ _id: buyId }, { $set: { estado: 'Cancelado' } })

describe('Phase 0 — commercial fact service', () => {
  before(async () => {
    await mongoose.connect(TEST_DB_URI)
  })

  after(async () => {
    const dbName = mongoose.connection.db && mongoose.connection.db.databaseName
    if (dbName && dbName.endsWith('_test')) {
      await mongoose.connection.dropDatabase()
    }
    await mongoose.disconnect()
  })

  beforeEach(async () => {
    await CommercialFactModel.deleteMany({})
    await ItemBuyModel.deleteMany({})
    await BuyModel.deleteMany({})
    await SaleModel.deleteMany({})
    spyStockPort = {
      commitSale: sinon.stub().resolves(),
      receivePurchase: sinon.stub().resolves(),
      applyPurchaseAdjustment: sinon.stub().resolves(),
      applyPhysicalReturn: sinon.stub().resolves()
    }
  })

  describe('purchase payment', () => {
    it('S-02: confirming a purchase payment records the Finance outflow projection and never increases Stock', async () => {
      const buy = await createBuy(800)

      const result = await makeService().confirmPurchasePayment({
        aggregateId: String(buy._id),
        businessDate: new Date('2026-01-15T12:00:00Z'),
        idempotencyKey: 'pay-1'
      }, { actorId: 'actor-1' })

      expect(result.replayed).to.equal(false)
      expect(result.fact.type).to.equal('PURCHASE_PAYMENT')
      expect(result.fact.amount).to.equal(800)

      const stored = await BuyModel.findById(buy._id).lean()
      expect(stored.paidAt).to.deep.equal(new Date('2026-01-15T12:00:00Z'))
      expect(spyStockPort.receivePurchase.called).to.equal(false)
    })

    it('S-02a: a purchase paid before reception still records the outflow projection', async () => {
      const buy = await createBuy(800)

      const result = await makeService().confirmPurchasePayment({
        aggregateId: String(buy._id),
        businessDate: new Date('2026-01-15T12:00:00Z'),
        idempotencyKey: 'pay-a'
      }, { actorId: 'actor-1' })

      expect(result.fact.type).to.equal('PURCHASE_PAYMENT')
      const receiptCount = await CommercialFactModel.countDocuments({ type: 'PURCHASE_RECEIPT', aggregateId: String(buy._id) })
      expect(receiptCount).to.equal(0)
    })

    it('S-02b: a purchase paid after being received still records the outflow projection', async () => {
      const buy = await createBuyWithItems(800, 20)

      await makeService().receivePurchase({
        aggregateId: String(buy._id),
        businessDate: new Date('2026-01-15T12:00:00Z'),
        idempotencyKey: 'recv-b',
        lines: [{ quantity: 20 }]
      }, { actorId: 'actor-1' })

      const result = await makeService().confirmPurchasePayment({
        aggregateId: String(buy._id),
        businessDate: new Date('2026-01-16T12:00:00Z'),
        idempotencyKey: 'pay-b'
      }, { actorId: 'actor-1' })

      expect(result.fact.type).to.equal('PURCHASE_PAYMENT')
      const stored = await BuyModel.findById(buy._id).lean()
      expect(stored.paidAt).to.deep.equal(new Date('2026-01-16T12:00:00Z'))
      const receiptCount = await CommercialFactModel.countDocuments({ type: 'PURCHASE_RECEIPT', aggregateId: String(buy._id) })
      expect(receiptCount).to.equal(1)
    })
  })

  describe('purchase reception', () => {
    it('S-03: a complete purchase reception delegates to the Stock port without creating cash', async () => {
      const buy = await createBuyWithItems(800, 20)

      const result = await makeService().receivePurchase({
        aggregateId: String(buy._id),
        businessDate: new Date('2026-01-16T12:00:00Z'),
        idempotencyKey: 'recv-1',
        lines: [{ quantity: 20 }]
      }, { actorId: 'actor-1' })

      expect(result.replayed).to.equal(false)
      expect(result.fact.type).to.equal('PURCHASE_RECEIPT')
      expect(spyStockPort.receivePurchase.calledOnce).to.equal(true)

      const stored = await BuyModel.findById(buy._id).lean()
      expect(stored.paidAt).to.equal(undefined)
    })

    it('S-03a: a purchase previously paid still delegates a complete reception to Stock', async () => {
      const buy = await createBuyWithItems(800, 20)
      const service = makeService()

      await service.confirmPurchasePayment({
        aggregateId: String(buy._id),
        businessDate: new Date('2026-01-15T12:00:00Z'),
        idempotencyKey: 'pay-a'
      }, { actorId: 'actor-1' })

      await service.receivePurchase({
        aggregateId: String(buy._id),
        businessDate: new Date('2026-01-16T12:00:00Z'),
        idempotencyKey: 'recv-a',
        lines: [{ quantity: 20 }]
      }, { actorId: 'actor-1' })

      expect(spyStockPort.receivePurchase.calledOnce).to.equal(true)
    })

    it('S-03b: a purchase not yet paid still delegates a complete reception to Stock without cash', async () => {
      const buy = await createBuyWithItems(800, 20)

      await makeService().receivePurchase({
        aggregateId: String(buy._id),
        businessDate: new Date('2026-01-16T12:00:00Z'),
        idempotencyKey: 'recv-b',
        lines: [{ quantity: 20 }]
      }, { actorId: 'actor-1' })

      expect(spyStockPort.receivePurchase.calledOnce).to.equal(true)
      const stored = await BuyModel.findById(buy._id).lean()
      expect(stored.paidAt).to.equal(undefined)
    })
  })

  describe('sale refund', () => {
    const pay = async (service, sale, key) =>
      service.confirmSalePayment({
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-10T12:00:00Z'),
        idempotencyKey: key
      }, { actorId: 'actor-1' })

    it('S-04: a partial refund records a Finance outflow and keeps the original payment traceable', async () => {
      const sale = await createSale(1000)
      const service = makeService()
      await pay(service, sale, 'pay-1')

      const refund = await service.recordSaleRefund({
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-11T12:00:00Z'),
        idempotencyKey: 'ref-1',
        amount: 250,
        reason: 'partial refund'
      }, { actorId: 'actor-2' })

      expect(refund.replayed).to.equal(false)
      expect(refund.fact.type).to.equal('SALE_REFUND')
      expect(refund.fact.amount).to.equal(250)

      const paymentFact = await CommercialFactModel.findOne({ type: 'SALE_PAYMENT', aggregateId: String(sale._id) }).lean()
      expect(paymentFact).to.not.equal(null)
      expect(paymentFact.amount).to.equal(1000)
    })

    it('S-04a: a full refund is accepted and leaves the original payment traceable', async () => {
      const sale = await createSale(1000)
      const service = makeService()
      await pay(service, sale, 'pay-1')

      const refund = await service.recordSaleRefund({
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-11T12:00:00Z'),
        idempotencyKey: 'ref-a',
        amount: 1000
      }, { actorId: 'actor-2' })

      expect(refund.fact.amount).to.equal(1000)
      const paymentCount = await CommercialFactModel.countDocuments({ type: 'SALE_PAYMENT', aggregateId: String(sale._id) })
      expect(paymentCount).to.equal(1)
    })

    it('S-04b: a second refund that stays within the collected total is accepted', async () => {
      const sale = await createSale(1000)
      const service = makeService()
      await pay(service, sale, 'pay-1')

      await service.recordSaleRefund({
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-11T12:00:00Z'),
        idempotencyKey: 'ref-b1',
        amount: 250
      }, { actorId: 'actor-2' })

      const second = await service.recordSaleRefund({
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-12T12:00:00Z'),
        idempotencyKey: 'ref-b2',
        amount: 500
      }, { actorId: 'actor-2' })

      expect(second.fact.amount).to.equal(500)
    })
  })

  describe('duplicate sale payment', () => {
    it('S-10: a duplicate full payment is rejected with SALE_ALREADY_PAID and no second cash entry', async () => {
      const sale = await createSale(1000)
      const service = makeService()

      await service.confirmSalePayment({
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-10T12:00:00Z'),
        idempotencyKey: 'pay-1'
      }, { actorId: 'actor-1' })

      const error = await captureError(service.confirmSalePayment({
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-11T12:00:00Z'),
        idempotencyKey: 'pay-2'
      }, { actorId: 'actor-1' }))

      expect(error).to.be.instanceOf(CommercialFactError)
      expect(error.code).to.equal('SALE_ALREADY_PAID')

      const paymentCount = await CommercialFactModel.countDocuments({ type: 'SALE_PAYMENT', aggregateId: String(sale._id) })
      expect(paymentCount).to.equal(1)
      const stored = await SaleModel.findById(sale._id).lean()
      expect(stored.paidAt).to.deep.equal(new Date('2026-01-10T12:00:00Z'))
    })

    it('S-10a: the sale creator cannot record a second payment [NFR-001]', async () => {
      const sale = await createSale(1000)
      const service = makeService()

      await service.confirmSalePayment({
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-10T12:00:00Z'),
        idempotencyKey: 'pay-1'
      }, { actorId: 'creator' })

      const error = await captureError(service.confirmSalePayment({
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-11T12:00:00Z'),
        idempotencyKey: 'pay-2'
      }, { actorId: 'creator' }))

      expect(error.code).to.equal('SALE_ALREADY_PAID')
      const paymentCount = await CommercialFactModel.countDocuments({ type: 'SALE_PAYMENT', aggregateId: String(sale._id) })
      expect(paymentCount).to.equal(1)
      expect(spyStockPort.receivePurchase.called).to.equal(false)
    })

    it('S-10b: Administración cannot record a second payment either [NFR-001]', async () => {
      const sale = await createSale(1000)
      const service = makeService()

      await service.confirmSalePayment({
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-10T12:00:00Z'),
        idempotencyKey: 'pay-1'
      }, { actorId: 'creator' })

      const error = await captureError(service.confirmSalePayment({
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-11T12:00:00Z'),
        idempotencyKey: 'pay-3'
      }, { actorId: 'admin' }))

      expect(error.code).to.equal('SALE_ALREADY_PAID')
      const paymentCount = await CommercialFactModel.countDocuments({ type: 'SALE_PAYMENT', aggregateId: String(sale._id) })
      expect(paymentCount).to.equal(1)
    })
  })

  describe('refund limits', () => {
    it('S-11: a refund exceeding the collected total is rejected with REFUND_EXCEEDS_COLLECTED', async () => {
      const sale = await createSale(1000)
      const service = makeService()

      await service.confirmSalePayment({
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-10T12:00:00Z'),
        idempotencyKey: 'pay-1'
      }, { actorId: 'actor-1' })

      await service.recordSaleRefund({
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-11T12:00:00Z'),
        idempotencyKey: 'ref-1',
        amount: 800
      }, { actorId: 'actor-2' })

      const error = await captureError(service.recordSaleRefund({
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-12T12:00:00Z'),
        idempotencyKey: 'ref-2',
        amount: 250
      }, { actorId: 'actor-2' }))

      expect(error).to.be.instanceOf(CommercialFactError)
      expect(error.code).to.equal('REFUND_EXCEEDS_COLLECTED')
      const refundCount = await CommercialFactModel.countDocuments({ type: 'SALE_REFUND', aggregateId: String(sale._id) })
      expect(refundCount).to.equal(1)
    })

    it('S-11a: exceeding the collected total by one is rejected', async () => {
      const sale = await createSale(1000)
      const service = makeService()

      await service.confirmSalePayment({
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-10T12:00:00Z'),
        idempotencyKey: 'pay-1'
      }, { actorId: 'actor-1' })

      await service.recordSaleRefund({
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-11T12:00:00Z'),
        idempotencyKey: 'ref-1',
        amount: 1000
      }, { actorId: 'actor-2' })

      const error = await captureError(service.recordSaleRefund({
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-12T12:00:00Z'),
        idempotencyKey: 'ref-2',
        amount: 1
      }, { actorId: 'actor-2' }))

      expect(error.code).to.equal('REFUND_EXCEEDS_COLLECTED')
    })

    it('S-11b: exceeding after several valid refunds is rejected', async () => {
      const sale = await createSale(1000)
      const service = makeService()

      await service.confirmSalePayment({
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-10T12:00:00Z'),
        idempotencyKey: 'pay-1'
      }, { actorId: 'actor-1' })

      await service.recordSaleRefund({
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-11T12:00:00Z'),
        idempotencyKey: 'ref-1',
        amount: 500
      }, { actorId: 'actor-2' })

      await service.recordSaleRefund({
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-12T12:00:00Z'),
        idempotencyKey: 'ref-2',
        amount: 400
      }, { actorId: 'actor-2' })

      const error = await captureError(service.recordSaleRefund({
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-13T12:00:00Z'),
        idempotencyKey: 'ref-3',
        amount: 101
      }, { actorId: 'actor-2' }))

      expect(error.code).to.equal('REFUND_EXCEEDS_COLLECTED')
      const refundCount = await CommercialFactModel.countDocuments({ type: 'SALE_REFUND', aggregateId: String(sale._id) })
      expect(refundCount).to.equal(2)
    })
  })

  describe('partial reception', () => {
    it('S-12: a partial purchase reception is rejected with PURCHASE_PARTIAL_RECEIPT_UNSUPPORTED', async () => {
      const buy = await createBuyWithItems(800, 20)
      const service = makeService()

      const error = await captureError(service.receivePurchase({
        aggregateId: String(buy._id),
        businessDate: new Date('2026-01-16T12:00:00Z'),
        idempotencyKey: 'recv-1',
        lines: [{ quantity: 10 }]
      }, { actorId: 'actor-1' }))

      expect(error).to.be.instanceOf(CommercialFactError)
      expect(error.code).to.equal('PURCHASE_PARTIAL_RECEIPT_UNSUPPORTED')
      expect(spyStockPort.receivePurchase.called).to.equal(false)

      const receiptCount = await CommercialFactModel.countDocuments({ type: 'PURCHASE_RECEIPT', aggregateId: String(buy._id) })
      expect(receiptCount).to.equal(0)
      const stored = await BuyModel.findById(buy._id).lean()
      expect(stored.paidAt).to.equal(undefined)
    })

    it('S-12a: a paid purchase still rejects a partial reception', async () => {
      const buy = await createBuyWithItems(800, 20)
      const service = makeService()

      await service.confirmPurchasePayment({
        aggregateId: String(buy._id),
        businessDate: new Date('2026-01-15T12:00:00Z'),
        idempotencyKey: 'pay-a'
      }, { actorId: 'actor-1' })

      const error = await captureError(service.receivePurchase({
        aggregateId: String(buy._id),
        businessDate: new Date('2026-01-16T12:00:00Z'),
        idempotencyKey: 'recv-a',
        lines: [{ quantity: 10 }]
      }, { actorId: 'actor-1' }))

      expect(error.code).to.equal('PURCHASE_PARTIAL_RECEIPT_UNSUPPORTED')
    })

    it('S-12b: an unpaid purchase still rejects a partial reception', async () => {
      const buy = await createBuyWithItems(800, 20)
      const service = makeService()

      const error = await captureError(service.receivePurchase({
        aggregateId: String(buy._id),
        businessDate: new Date('2026-01-16T12:00:00Z'),
        idempotencyKey: 'recv-b',
        lines: [{ quantity: 5 }]
      }, { actorId: 'actor-1' }))

      expect(error.code).to.equal('PURCHASE_PARTIAL_RECEIPT_UNSUPPORTED')
      expect(spyStockPort.receivePurchase.called).to.equal(false)
    })
  })

  describe('compensatory adjustment', () => {
    it('S-14: a compensatory adjustment preserves the original reception and delegates to Stock', async () => {
      const buy = await createBuyWithItems(800, 20)
      const service = makeService()

      await service.receivePurchase({
        aggregateId: String(buy._id),
        businessDate: new Date('2026-01-16T12:00:00Z'),
        idempotencyKey: 'recv-1',
        lines: [{ quantity: 20 }]
      }, { actorId: 'actor-1' })

      const receiptFact = await CommercialFactModel.findOne({ type: 'PURCHASE_RECEIPT', aggregateId: String(buy._id) }).lean()

      const adjustment = await service.applyPurchaseAdjustment({
        aggregateId: String(buy._id),
        businessDate: new Date('2026-01-17T12:00:00Z'),
        idempotencyKey: 'adj-1',
        sourceFactId: String(receiptFact._id),
        reason: 'physical count',
        lines: [{ quantity: -2 }]
      }, { actorId: 'actor-1' })

      expect(adjustment.fact.type).to.equal('PURCHASE_ADJUSTMENT')
      expect(spyStockPort.applyPurchaseAdjustment.calledOnce).to.equal(true)

      const storedReceipt = await CommercialFactModel.findById(receiptFact._id).lean()
      expect(storedReceipt).to.not.equal(null)
      expect(storedReceipt.lines).to.deep.equal([{ quantity: 20 }])
    })

    it('S-14a: an adjustment by physical difference keeps the original reception intact', async () => {
      const buy = await createBuyWithItems(800, 20)
      const service = makeService()

      await service.receivePurchase({
        aggregateId: String(buy._id),
        businessDate: new Date('2026-01-16T12:00:00Z'),
        idempotencyKey: 'recv-a',
        lines: [{ quantity: 20 }]
      }, { actorId: 'actor-1' })

      const receiptFact = await CommercialFactModel.findOne({ type: 'PURCHASE_RECEIPT', aggregateId: String(buy._id) }).lean()

      await service.applyPurchaseAdjustment({
        aggregateId: String(buy._id),
        businessDate: new Date('2026-01-17T12:00:00Z'),
        idempotencyKey: 'adj-a',
        sourceFactId: String(receiptFact._id),
        reason: 'physical difference',
        lines: [{ quantity: -1 }]
      }, { actorId: 'actor-1' })

      const storedReceipt = await CommercialFactModel.findById(receiptFact._id).lean()
      expect(storedReceipt.lines).to.deep.equal([{ quantity: 20 }])
    })

    it('S-14b: an adjustment by supplier return keeps the original reception intact', async () => {
      const buy = await createBuyWithItems(800, 20)
      const service = makeService()

      await service.receivePurchase({
        aggregateId: String(buy._id),
        businessDate: new Date('2026-01-16T12:00:00Z'),
        idempotencyKey: 'recv-b',
        lines: [{ quantity: 20 }]
      }, { actorId: 'actor-1' })

      const receiptFact = await CommercialFactModel.findOne({ type: 'PURCHASE_RECEIPT', aggregateId: String(buy._id) }).lean()

      await service.applyPurchaseAdjustment({
        aggregateId: String(buy._id),
        businessDate: new Date('2026-01-17T12:00:00Z'),
        idempotencyKey: 'adj-b',
        sourceFactId: String(receiptFact._id),
        reason: 'supplier return',
        lines: [{ quantity: -3 }]
      }, { actorId: 'actor-1' })

      expect(spyStockPort.applyPurchaseAdjustment.calledOnce).to.equal(true)
      const storedReceipt = await CommercialFactModel.findById(receiptFact._id).lean()
      expect(storedReceipt.lines).to.deep.equal([{ quantity: 20 }])
    })
  })

  describe('purchase history preservation', () => {
    it('S-19: a cancelled purchase preserves its payment and reception facts', async () => {
      const buy = await createBuyWithItems(800, 20)
      const service = makeService()

      await service.confirmPurchasePayment({
        aggregateId: String(buy._id),
        businessDate: new Date('2026-01-15T12:00:00Z'),
        idempotencyKey: 'pay-1'
      }, { actorId: 'actor-1' })

      await service.receivePurchase({
        aggregateId: String(buy._id),
        businessDate: new Date('2026-01-16T12:00:00Z'),
        idempotencyKey: 'recv-1',
        lines: [{ quantity: 20 }]
      }, { actorId: 'actor-1' })

      await cancelBuy(buy._id)

      const paymentCount = await CommercialFactModel.countDocuments({ type: 'PURCHASE_PAYMENT', aggregateId: String(buy._id) })
      const receiptCount = await CommercialFactModel.countDocuments({ type: 'PURCHASE_RECEIPT', aggregateId: String(buy._id) })
      expect(paymentCount).to.equal(1)
      expect(receiptCount).to.equal(1)
    })

    it('S-19a: a cancelled purchase that was only paid preserves its payment fact', async () => {
      const buy = await createBuy(800)
      const service = makeService()

      await service.confirmPurchasePayment({
        aggregateId: String(buy._id),
        businessDate: new Date('2026-01-15T12:00:00Z'),
        idempotencyKey: 'pay-a'
      }, { actorId: 'actor-1' })

      await cancelBuy(buy._id)

      const paymentCount = await CommercialFactModel.countDocuments({ type: 'PURCHASE_PAYMENT', aggregateId: String(buy._id) })
      expect(paymentCount).to.equal(1)
    })

    it('S-19b: a cancelled purchase that was only received preserves its reception fact', async () => {
      const buy = await createBuyWithItems(800, 20)
      const service = makeService()

      await service.receivePurchase({
        aggregateId: String(buy._id),
        businessDate: new Date('2026-01-16T12:00:00Z'),
        idempotencyKey: 'recv-b',
        lines: [{ quantity: 20 }]
      }, { actorId: 'actor-1' })

      await cancelBuy(buy._id)

      const receiptCount = await CommercialFactModel.countDocuments({ type: 'PURCHASE_RECEIPT', aggregateId: String(buy._id) })
      expect(receiptCount).to.equal(1)
    })

    it('S-33: cancelling a purchase preserves its payment and reception facts in the contractual history', async () => {
      const buy = await createBuyWithItems(800, 20)
      const service = makeService()

      await service.confirmPurchasePayment({
        aggregateId: String(buy._id),
        businessDate: new Date('2026-01-15T12:00:00Z'),
        idempotencyKey: 'pay-33'
      }, { actorId: 'actor-1' })

      await service.receivePurchase({
        aggregateId: String(buy._id),
        businessDate: new Date('2026-01-16T12:00:00Z'),
        idempotencyKey: 'recv-33',
        lines: [{ quantity: 20 }]
      }, { actorId: 'actor-1' })

      await cancelBuy(buy._id)

      const facts = await CommercialFactModel.find({ aggregateId: String(buy._id), aggregateType: 'buy' }).lean()
      const types = facts.map((fact) => fact.type).sort()
      expect(types).to.deep.equal(['PURCHASE_PAYMENT', 'PURCHASE_RECEIPT'])
    })
  })

  describe('idempotency', () => {
    it('S-26: an idempotent retry returns the original fact with replayed true', async () => {
      const sale = await createSale(1000)
      const service = makeService()
      const input = {
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-10T12:00:00Z'),
        idempotencyKey: 'pay-1'
      }

      const first = await service.confirmSalePayment(input, { actorId: 'actor-1' })
      const second = await service.confirmSalePayment(input, { actorId: 'actor-1' })

      expect(first.replayed).to.equal(false)
      expect(second.replayed).to.equal(true)
      expect(String(second.fact._id)).to.equal(String(first.fact._id))
      expect(second.fact.payloadHash).to.equal(first.fact.payloadHash)

      const paymentCount = await CommercialFactModel.countDocuments({ type: 'SALE_PAYMENT', aggregateId: String(sale._id) })
      expect(paymentCount).to.equal(1)
    })

    it('S-27: reusing an idempotency key with a different payload is rejected with no state change [NFR-001]', async () => {
      const sale = await createSale(1000)
      const service = makeService()

      await service.confirmSalePayment({
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-10T12:00:00Z'),
        idempotencyKey: 'pay-1'
      }, { actorId: 'actor-1' })

      const error = await captureError(service.confirmSalePayment({
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-11T12:00:00Z'),
        idempotencyKey: 'pay-1'
      }, { actorId: 'actor-1' }))

      expect(error).to.be.instanceOf(CommercialFactError)
      expect(error.code).to.equal('IDEMPOTENCY_KEY_CONFLICT')

      const paymentCount = await CommercialFactModel.countDocuments({ type: 'SALE_PAYMENT', aggregateId: String(sale._id) })
      expect(paymentCount).to.equal(1)
      const stored = await SaleModel.findById(sale._id).lean()
      expect(stored.paidAt).to.deep.equal(new Date('2026-01-10T12:00:00Z'))
    })
  })

  describe('traceability', () => {
    it('NFR-008: accepted facts persist actor, businessDate, sourceReference and correlationId', async () => {
      const sale = await createSale(1000)

      const result = await makeService().confirmSalePayment({
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-10T12:00:00Z'),
        idempotencyKey: 'pay-1'
      }, { actorId: 'actor-42', correlationId: 'corr-99' })

      expect(result.fact.actorId).to.equal('actor-42')
      expect(result.fact.businessDate).to.deep.equal(new Date('2026-01-10T12:00:00Z'))
      expect(result.fact.sourceReference).to.equal(`sale:${String(sale._id)}`)
      expect(result.fact.correlationId).to.equal('corr-99')
    })
  })

  describe('recoverable fact application', () => {
    it('correction R3-notify-non-atomic: a failed first attempt records FAILED_RECOVERABLE and the retry re-applies the finance projection', async () => {
      const sale = await createSale(1000)
      const financePort = {
        recordSalePayment: sinon.stub()
          .onFirstCall().rejects(new Error('projection unavailable'))
          .onSecondCall().callsFake(async (fact) => { await financePortAdapter.recordSalePayment(fact) }),
        recordSaleRefund: sinon.stub().resolves(),
        recordPurchasePayment: sinon.stub().resolves()
      }
      const service = new CommercialFactService({ financePort })
      const input = {
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-10T12:00:00Z'),
        idempotencyKey: 'pay-retry'
      }

      const firstError = await captureError(service.confirmSalePayment(input, { actorId: 'actor-1' }))
      expect(firstError).to.be.instanceOf(Error)
      expect(financePort.recordSalePayment.calledOnce).to.equal(true)

      const storedAfterFailure = await CommercialFactModel.findOne({ type: 'SALE_PAYMENT', aggregateId: String(sale._id) }).lean()
      expect(storedAfterFailure.status).to.equal('FAILED_RECOVERABLE')
      const saleAfterFailure = await SaleModel.findById(sale._id).lean()
      expect(saleAfterFailure.paidAt).to.equal(undefined)

      const retried = await service.confirmSalePayment(input, { actorId: 'actor-1' })
      expect(retried.replayed).to.equal(true)
      expect(financePort.recordSalePayment.calledTwice).to.equal(true)

      const storedAfterRetry = await CommercialFactModel.findOne({ type: 'SALE_PAYMENT', aggregateId: String(sale._id) }).lean()
      expect(storedAfterRetry.status).to.equal('APPLIED')
      const saleAfterRetry = await SaleModel.findById(sale._id).lean()
      expect(saleAfterRetry.paidAt).to.deep.equal(new Date('2026-01-10T12:00:00Z'))
    })

    it('correction R3-race-check-then-act: a unique-index duplicate create race resolves to the recorded fact replay, never a raw duplicate error', async () => {
      const sale = await createSale(1000)
      const service = makeService()
      const input = {
        aggregateId: String(sale._id),
        businessDate: new Date('2026-01-10T12:00:00Z'),
        idempotencyKey: 'deliver-race'
      }

      const first = await service.recordSaleDelivery(input, { actorId: 'actor-1' })
      expect(first.replayed).to.equal(false)
      expect(first.fact.status).to.equal('APPLIED')

      let missNextIdempotencyLookup = true
      const originalFindOne = CommercialFactModel.findOne.bind(CommercialFactModel)
      const missIdempotencyLookup = sinon.stub(CommercialFactModel, 'findOne').callsFake((query) => {
        if (missNextIdempotencyLookup === true && query.idempotencyKey === 'deliver-race') {
          missNextIdempotencyLookup = false
          return originalFindOne({ ...query, idempotencyKey: `${query.idempotencyKey}-missed` })
        }
        return originalFindOne(query)
      })
      const duplicateKeyError = Object.assign(new Error('E11000 duplicate key error collection: commercialfacts'), { code: 11000 })
      const duplicateCreate = sinon.stub(CommercialFactModel, 'create').rejects(duplicateKeyError)

      try {
        const raced = await service.recordSaleDelivery(input, { actorId: 'actor-2' })
        expect(raced.replayed).to.equal(true)
        expect(String(raced.fact._id)).to.equal(String(first.fact._id))
      } finally {
        missIdempotencyLookup.restore()
        duplicateCreate.restore()
      }

      const deliveryCount = await CommercialFactModel.countDocuments({ type: 'SALE_DELIVERY', aggregateId: String(sale._id) })
      expect(deliveryCount).to.equal(1)
    })
  })
})
