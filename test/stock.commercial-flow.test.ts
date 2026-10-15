import { expect } from 'chai'
import sinon from 'sinon'

import { STOCK_ERROR_CODES } from '../src/interfaces/stock.interface'
import { StockService, StockServiceError } from '../src/services/stock'
import {
  mapPhysicalReturnToStockInput,
  mapPurchaseReceiptToStockInput,
  mapSaleReferenceToStockCommitInput,
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

  it('maps physical return aliases, date, actor, and operation while ignoring price and bulto', () => {
    const source = fact({
      type: 'SALE_PHYSICAL_RETURN',
      aggregateType: 'sale',
      aggregateId: '507f1f77bcf86cd799439011',
      idempotencyKey: 'commercial-return-1',
      lines: [{ productId: '507f1f77bcf86cd799439014', lineId: 'arbitrary-line-id', quantity: 2, quantityReturned: 2, price: 99, bulto: 12 }]
    })
    const mapped = mapPhysicalReturnToStockInput(source)
    const saleMapped = mapSaleReferenceToStockCommitInput(source)

    expect(mapped).to.deep.include({
      saleId: '507f1f77bcf86cd799439011',
      operationId: 'commercial-return-1',
      businessDate: '2026-10-15'
    })
    expect(mapped.auth).to.deep.equal({ actorId: '507f1f77bcf86cd799439013', canManageStock: false })
    expect(mapped.lines).to.deep.equal([{ productId: '507f1f77bcf86cd799439014', lineId: saleMapped.lines[0].lineId, quantity: 2 }])
    expect(mapped.lines[0].lineId).to.match(/^[0-9a-f]{24}$/)
    expect(mapped.occurredAt).to.deep.equal(fact().businessDate)
  })

  it('accepts every explicit physical return product and quantity alias', () => {
    for (const productField of ['productId', 'idProducto', '_id']) {
      for (const quantityField of ['quantity', 'quantityReturned', 'cantidad']) {
        const value = productField === '_id' ? '507f1f77bcf86cd799439014' : 'product-1'
        const mapped = mapPhysicalReturnToStockInput(fact({ lines: [{ [productField]: value, [quantityField]: 2 }] }))
        expect(mapped.lines[0]).to.deep.include({ productId: value, quantity: 2 })
      }
    }
  })

  it('rejects malformed physical return lines before calling StockService', async () => {
    const returnSale = sinon.stub(StockService.prototype, 'returnSale')
    for (const lines of [[{ quantity: 2 }], [{ productId: 'product-1', quantity: 0 }], [{ productId: 'product-1', quantity: 2, cantidad: 3 }]]) {
      try {
        await stockPortAdapter.applyPhysicalReturn(fact({ type: 'SALE_PHYSICAL_RETURN', aggregateType: 'sale', lines }))
        expect.fail('expected malformed physical return to reject')
      } catch (error) {
        expect(error).to.be.instanceOf(StockServiceError)
        expect(error).to.have.property('code', STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE)
      }
    }
    expect(returnSale.called).to.equal(false)
  })

  it('routes valid physical return facts to StockService with strict mapping', async () => {
    const returnSale = sinon.stub(StockService.prototype, 'returnSale').resolves({
      status: 'APPLIED',
      operationId: 'commercial-return-2',
      movementCount: 1,
      appliedMovementCount: 1,
      alreadyAppliedCount: 0,
      projectionCount: 1
    })

    await stockPortAdapter.applyPhysicalReturn(fact({
      type: 'SALE_PHYSICAL_RETURN',
      aggregateType: 'sale',
      idempotencyKey: 'commercial-return-2',
      lines: [{ idProducto: 'product-1', cantidad: 2, price: 99, bulto: 12 }]
    }))

    expect(returnSale.calledOnce).to.equal(true)
    expect(returnSale.firstCall.args[0]).to.deep.include({ saleId: '507f1f77bcf86cd799439011', operationId: 'commercial-return-2', businessDate: '2026-10-15' })
    expect(returnSale.firstCall.args[0].auth).to.deep.equal({ actorId: '507f1f77bcf86cd799439013', canManageStock: false })
    expect(returnSale.firstCall.args[0].lines).to.deep.equal([{ productId: 'product-1', quantity: 2 }])
  })
})
