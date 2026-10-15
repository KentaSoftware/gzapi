import { expect } from 'chai'
import sinon from 'sinon'

import { STOCK_ERROR_CODES } from '../src/interfaces/stock.interface'
import { StockService, StockServiceError } from '../src/services/stock'
import {
  mapPurchaseReceiptToStockInput,
  stockPortAdapter
} from '../src/services/commercialPorts'
import type { CommercialFact } from '../src/interfaces/commercialFact.interface'

const fact = (overrides: Partial<CommercialFact> = {}): CommercialFact => ({
  type: 'PURCHASE_RECEIPT',
  aggregateType: 'buy',
  aggregateId: '507f1f77bcf86cd799439011',
  businessDate: new Date('2026-10-15T12:00:00.000Z'),
  actorId: '507f1f77bcf86cd799439013',
  sourceReference: 'buy:507f1f77bcf86cd799439011',
  idempotencyKey: 'commercial-receipt-1',
  payloadHash: 'hash',
  status: 'APPLIED',
  createdAt: new Date('2026-10-15T12:00:00.000Z'),
  ...overrides
})

describe('Stock commercial flow', () => {
  afterEach(() => sinon.restore())

  it('maps explicit receipt fields, aliases, operation identity, and actor while ignoring price and bulto', () => {
    const mapped = mapPurchaseReceiptToStockInput(fact({
      lines: [{ _id: '507f1f77bcf86cd799439012', idProducto: '507f1f77bcf86cd799439014', cantidad: 3, precio: 99, bulto: 12, expiryDate: '2026-11-01' }]
    }))

    expect(mapped).to.deep.include({
      buyId: '507f1f77bcf86cd799439011',
      businessDate: '2026-10-15',
      operationId: 'commercial-receipt-1',
      receivedBy: '507f1f77bcf86cd799439013'
    })
    expect(mapped.lines).to.deep.equal([{
      itemBuyId: '507f1f77bcf86cd799439012',
      productId: '507f1f77bcf86cd799439014',
      quantityReceived: 3,
      expiryDate: '2026-11-01'
    }])
  })

  it('accepts quantityReceived, quantity, and cantidad but rejects malformed or conflicting lines', () => {
    for (const quantityField of ['quantityReceived', 'quantity', 'cantidad']) {
      const mapped = mapPurchaseReceiptToStockInput(fact({ lines: [{ itemBuyId: 'item-1', productId: 'product-1', [quantityField]: 2 }] }))
      expect(mapped.lines[0].quantityReceived).to.equal(2)
    }
    expect(() => mapPurchaseReceiptToStockInput(fact({ lines: [{ itemBuyId: 'item-1', productId: 'product-1', quantity: 0 }] }))).to.throw(StockServiceError)
    expect(() => mapPurchaseReceiptToStockInput(fact({ lines: [{ itemBuyId: 'item-1', productId: 'product-1', quantity: 2, cantidad: 3 }] }))).to.throw(StockServiceError)
    try {
      mapPurchaseReceiptToStockInput(fact({ lines: [{ itemBuyId: 'item-1', productId: 'product-1', quantity: 0 }] }))
      expect.fail('expected malformed receipt line to reject')
    } catch (error) {
      expect(error).to.have.property('code', STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE)
    }
  })

  it('routes receipt facts to StockService with normalized business identity', async () => {
    const receivePurchase = sinon.stub(StockService.prototype, 'receivePurchase').resolves({
      status: 'APPLIED',
      operationId: 'commercial-receipt-2',
      movementCount: 1,
      appliedMovementCount: 1,
      alreadyAppliedCount: 0,
      projectionCount: 1
    })

    await stockPortAdapter.receivePurchase(fact({
      idempotencyKey: 'commercial-receipt-2',
      lines: [{ itemBuyId: '507f1f77bcf86cd799439012', productId: '507f1f77bcf86cd799439014', quantityReceived: 2 }]
    }))

    expect(receivePurchase.calledOnce).to.equal(true)
    expect(receivePurchase.firstCall.args[0]).to.deep.include({
      buyId: '507f1f77bcf86cd799439011',
      businessDate: '2026-10-15',
      operationId: 'commercial-receipt-2',
      receivedBy: '507f1f77bcf86cd799439013'
    })
  })

  it('rejects quantity-only receipt facts instead of acknowledging them', async () => {
    const receivePurchase = sinon.stub(StockService.prototype, 'receivePurchase')

    try {
      await stockPortAdapter.receivePurchase(fact({
        idempotencyKey: 'commercial-receipt-malformed',
        lines: [{ quantity: 2 }]
      }))
      expect.fail('expected quantity-only receipt to reject')
    } catch (error) {
      expect(error).to.be.instanceOf(StockServiceError)
      expect(error).to.have.property('code', STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE)
    }

    expect(receivePurchase.called).to.equal(false)
  })
})
