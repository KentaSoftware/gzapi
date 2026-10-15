import { expect } from 'chai'
import sinon from 'sinon'
import { Types } from 'mongoose'

import {
  BASELINE_STATUS,
  EXPIRY_TRACKING,
  INVENTORY_MOVEMENT_TYPES,
  STOCK_ERROR_CODES
} from '../src/interfaces/stock.interface'
import {
  mapBucketDocumentToStockSnapshot,
  mapMovementDocumentToStockRecord,
  MongooseStockRepository,
  mapProductDocumentToStockSnapshot
} from '../src/services/stockMongoRepository'
import { STOCK_TIME_ZONE } from '../src/config/stock'
import ProductModel from '../src/models/product'
import InventoryMovementModel from '../src/models/inventoryMovement'
import StockExpiryBucketModel from '../src/models/stockExpiryBucket'
import {
  mapSaleReferenceToStockCommitInput,
  buenosAiresCivilDate,
  SaleCommitmentReference
} from '../src/services/commercialPorts'
import { StockServiceError } from '../src/services/stock'

describe('Stock Mongo repository and commercial reference mapping', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('maps Product.stock only to physical quantity and derives availability from committed quantity', () => {
    const snapshot = mapProductDocumentToStockSnapshot({
      _id: new Types.ObjectId('507f1f77bcf86cd799439011'),
      stock: 12,
      inventory: {
        expiryTracking: EXPIRY_TRACKING.NOT_TRACKED,
        baselineStatus: BASELINE_STATUS.RECONCILED
      }
    }, 5)

    expect(snapshot).to.deep.equal({
      productId: '507f1f77bcf86cd799439011',
      physicalQuantity: 12,
      committedQuantity: 5,
      availableQuantity: 7,
      expiryTracking: EXPIRY_TRACKING.NOT_TRACKED,
      baselineStatus: BASELINE_STATUS.RECONCILED
    })
  })

  it('normalizes a non-canonical near-midnight UTC expiry through Buenos Aires time', () => {
    const snapshot = mapBucketDocumentToStockSnapshot({
      _id: new Types.ObjectId('507f1f77bcf86cd799439012'),
      productId: new Types.ObjectId('507f1f77bcf86cd799439011'),
      expiryDate: new Date('2026-10-16T02:00:00.000Z'),
      receivedQuantity: 10,
      availableQuantity: 4,
      committedQuantity: 6
    })

    expect(snapshot).to.deep.equal({
      bucketId: '507f1f77bcf86cd799439012',
      productId: '507f1f77bcf86cd799439011',
      expiryDate: '2026-10-15',
      receivedQuantity: 10,
      availableQuantity: 4,
      committedQuantity: 6
    })
  })

  it('interprets a Mongoose-canonical midnight UTC expiry as its stored civil date', () => {
    const snapshot = mapBucketDocumentToStockSnapshot({
      _id: new Types.ObjectId('507f1f77bcf86cd799439014'),
      productId: new Types.ObjectId('507f1f77bcf86cd799439011'),
      expiryDate: new Date('2026-10-16T00:00:00.000Z'),
      receivedQuantity: 10,
      availableQuantity: 4,
      committedQuantity: 6
    })

    expect(snapshot.expiryDate).to.equal('2026-10-16')
  })

  it('maps a lightweight sale reference with a deterministic date and ignores price or bulto fields', () => {
    const reference: SaleCommitmentReference = {
      saleId: 'sale-1',
      operationId: 'sale-operation-1',
      businessDate: '2026-10-15',
      lines: [{ _id: '507f1f77bcf86cd799439011', cantidad: 2, precio: 99, bulto: 12 }],
      actorId: '507f1f77bcf86cd799439013'
    }

    expect(mapSaleReferenceToStockCommitInput(reference)).to.deep.include({
      saleId: 'sale-1',
      operationId: 'sale-operation-1',
      businessDate: '2026-10-15',
      auth: { actorId: '507f1f77bcf86cd799439013', canManageStock: false }
    })
    const mapped = mapSaleReferenceToStockCommitInput(reference)
    expect(mapped.lines).to.have.length(1)
    expect(mapped.lines[0]).to.include({ productId: '507f1f77bcf86cd799439011', quantity: 2 })
    expect(mapped.lines[0].lineId).to.match(/^[0-9a-f]{24}$/)
  })

  it('maps source line IDs to deterministic, valid ObjectIds distinct across sales and lines', () => {
    const baseReference: SaleCommitmentReference = {
      saleId: 'sale-1',
      operationId: 'sale-operation-1',
      businessDate: '2026-10-15',
      lines: [
        { lineId: 'arbitrary-line-id', productId: 'product-1', quantity: 1 },
        { lineId: '507f1f77bcf86cd799439012', productId: 'product-2', quantity: 1 }
      ],
      actorId: '507f1f77bcf86cd799439013'
    }

    const first = mapSaleReferenceToStockCommitInput(baseReference)
    const retry = mapSaleReferenceToStockCommitInput(baseReference)
    const otherSale = mapSaleReferenceToStockCommitInput({ ...baseReference, saleId: 'sale-2' })

    expect(first.lines[0].lineId).to.equal(retry.lines[0].lineId)
    expect(first.lines[0].lineId).to.match(/^[0-9a-f]{24}$/)
    expect(first.lines[1].lineId).to.equal('507f1f77bcf86cd799439012')
    expect(first.lines[0].lineId).to.not.equal(first.lines[1].lineId)
    expect(first.lines[0].lineId).to.not.equal(otherSale.lines[0].lineId)
  })

  it('normalizes sale business dates using the configured stock timezone', () => {
    const date = new Date('2026-10-16T02:00:00.000Z')
    const expectedParts = new Intl.DateTimeFormat('en-US', {
      timeZone: STOCK_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date)
    const partValue = (type: 'year' | 'month' | 'day'): string => {
      const value = expectedParts.find((part) => part.type === type)?.value
      if (value === undefined) throw new Error(`Missing date part ${type}`)
      return value
    }
    const expected = `${partValue('year')}-${partValue('month')}-${partValue('day')}`

    expect(buenosAiresCivilDate(date)).to.equal(expected)
  })

  it('preserves validated movement audit timestamps when mapping Mongo documents', () => {
    const createdAt = new Date('2026-10-15T10:00:00.000Z')
    const updatedAt = new Date('2026-10-15T11:00:00.000Z')
    const mapped = mapMovementDocumentToStockRecord({
      _id: new Types.ObjectId('507f1f77bcf86cd799439011'),
      productId: new Types.ObjectId('507f1f77bcf86cd799439012'),
      type: INVENTORY_MOVEMENT_TYPES.SALE_COMMIT,
      quantity: 2,
      occurredAt: new Date('2026-10-15T09:00:00.000Z'),
      sourceType: 'SALE',
      sourceId: 'sale-1',
      sourceEvent: 'COMMIT',
      operationId: 'operation-1',
      idempotencyKey: 'idempotency-1',
      rulesVersion: 'stock-rules-v1',
      createdBy: new Types.ObjectId('507f1f77bcf86cd799439013'),
      createdAt,
      updatedAt
    })

    expect(mapped.createdAt).to.deep.equal(createdAt)
    expect(mapped.updatedAt).to.deep.equal(updatedAt)
    expect(mapped.createdAt).to.not.equal(createdAt)
    expect(mapped.updatedAt).to.not.equal(updatedAt)
  })

  it('rejects malformed commercial lines with a typed Stock error', () => {
    const reference: SaleCommitmentReference = {
      saleId: 'sale-1',
      lines: [{ _id: 'line-1', idProducto: 'product-1', cantidad: 0 }],
      actorId: 'actor-1'
    }

    expect(() => mapSaleReferenceToStockCommitInput(reference)).to.throw(StockServiceError)
    try {
      mapSaleReferenceToStockCommitInput(reference)
      expect.fail('expected malformed line to be rejected')
    } catch (error) {
      expect(error).to.have.property('code', STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE)
    }
  })

  it('writes only physical product projection deltas to Product.stock', async () => {
    const updateQuery = {
      session: sinon.stub().returnsThis(),
      exec: sinon.stub().resolves({ matchedCount: 1 })
    }
    const updateStub = sinon.stub(ProductModel, 'updateOne').returns(updateQuery as unknown as ReturnType<typeof ProductModel.updateOne>)
    const repository = new MongooseStockRepository()

    await repository.applyProductProjectionDelta('507f1f77bcf86cd799439011', {
      availableQuantityDelta: 0,
      committedQuantityDelta: 0,
      physicalQuantityDelta: 3
    })

    expect(updateStub.calledOnce).to.equal(true)
    expect(updateStub.firstCall.args[1]).to.deep.equal({ $inc: { stock: 3 } })
  })

  it('applies bucket availability and commitment deltas atomically through one update', async () => {
    const updateQuery = {
      session: sinon.stub().returnsThis(),
      exec: sinon.stub().resolves({ matchedCount: 1 })
    }
    const updateStub = sinon.stub(StockExpiryBucketModel, 'updateOne').returns(updateQuery as unknown as ReturnType<typeof StockExpiryBucketModel.updateOne>)
    const repository = new MongooseStockRepository()

    await repository.applyBucketProjectionDelta('507f1f77bcf86cd799439012', {
      availableQuantityDelta: -2,
      committedQuantityDelta: 2,
      receivedQuantityDelta: -2
    })

    expect(updateStub.calledOnce).to.equal(true)
    expect(updateStub.firstCall.args[1]).to.deep.equal({
      $inc: { availableQuantity: -2, committedQuantity: 2, receivedQuantity: -2 }
    })
  })

  it('upserts physical receipt buckets with session-aware atomic increments', async () => {
    const updateQuery = {
      session: sinon.stub().returnsThis(),
      lean: sinon.stub().returnsThis(),
      exec: sinon.stub().resolves({
        _id: new Types.ObjectId('507f1f77bcf86cd799439012'),
        productId: new Types.ObjectId('507f1f77bcf86cd799439011'),
        expiryDate: new Date('2026-11-01T12:00:00.000Z'),
        receivedQuantity: 4,
        availableQuantity: 4,
        committedQuantity: 0
      })
    }
    const updateStub = sinon.stub(StockExpiryBucketModel, 'findOneAndUpdate').returns(updateQuery as unknown as ReturnType<typeof StockExpiryBucketModel.findOneAndUpdate>)
    const repository = new MongooseStockRepository()

    const snapshot = await repository.applyPhysicalBucketReceipt('507f1f77bcf86cd799439011', '2026-11-01', 4)

    expect(snapshot).to.deep.include({ expiryDate: '2026-11-01', receivedQuantity: 4, availableQuantity: 4, committedQuantity: 0 })
    expect(updateStub.calledOnce).to.equal(true)
    expect(updateStub.firstCall.args[0]).to.deep.equal({
      productId: new Types.ObjectId('507f1f77bcf86cd799439011'),
      expiryDate: '2026-11-01',
      receivedQuantity: { $gte: 0 },
      availableQuantity: { $gte: 0 },
      committedQuantity: { $gte: 0 }
    })
    expect(updateStub.firstCall.args[1]).to.deep.equal({
      $setOnInsert: {
        productId: new Types.ObjectId('507f1f77bcf86cd799439011'),
        expiryDate: '2026-11-01',
        receivedQuantity: 0,
        availableQuantity: 0,
        committedQuantity: 0
      },
      $inc: { receivedQuantity: 4, availableQuantity: 4 }
    })
  })

  it('rejects impossible civil expiry dates before writing', async () => {
    const updateStub = sinon.stub(StockExpiryBucketModel, 'findOneAndUpdate')
    const repository = new MongooseStockRepository()

    try {
      await repository.applyPhysicalBucketReceipt('507f1f77bcf86cd799439011', '2026-02-30', 4)
      expect.fail('expected impossible expiry date to reject')
    } catch (error) {
      expect(error).to.be.instanceOf(StockServiceError)
      expect(error).to.have.property('code', STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR)
    }

    expect(updateStub.called).to.equal(false)
  })

  it('derives non-tracked commitments after delivered-out movements', async () => {
    const productId = new Types.ObjectId('507f1f77bcf86cd799439011')
    const actorId = new Types.ObjectId('507f1f77bcf86cd799439013')
    const occurredAt = new Date('2026-10-15T12:00:00.000Z')
    const movement = {
      _id: new Types.ObjectId('507f1f77bcf86cd799439014'),
      productId,
      type: INVENTORY_MOVEMENT_TYPES.SALE_COMMIT,
      quantity: 3,
      occurredAt,
      sourceType: 'SALE',
      sourceId: 'sale-1',
      sourceEvent: 'SALE_COMMIT',
      operationId: 'operation-1',
      idempotencyKey: 'idempotency-1',
      rulesVersion: 'stock-rules-v1',
      createdBy: actorId,
      createdAt: occurredAt,
      updatedAt: occurredAt
    }
    const delivered = { ...movement, _id: new Types.ObjectId('507f1f77bcf86cd799439015'), type: INVENTORY_MOVEMENT_TYPES.SALE_DELIVERED_OUT, sourceEvent: 'SALE_DELIVERY', idempotencyKey: 'idempotency-2', reversesMovementId: movement._id }
    const productQuery = {
      lean: sinon.stub().returnsThis(),
      exec: sinon.stub().resolves({ _id: productId, stock: 10, inventory: { expiryTracking: EXPIRY_TRACKING.NOT_TRACKED, baselineStatus: BASELINE_STATUS.RECONCILED } })
    }
    const movementQuery = {
      lean: sinon.stub().returnsThis(),
      exec: sinon.stub().resolves([movement, delivered])
    }
    sinon.stub(ProductModel, 'findById').returns(productQuery as unknown as ReturnType<typeof ProductModel.findById>)
    const findStub = sinon.stub(InventoryMovementModel, 'find').returns(movementQuery as unknown as ReturnType<typeof InventoryMovementModel.find>)
    const repository = new MongooseStockRepository()

    const snapshot = await repository.getProduct(productId.toString())

    expect(snapshot).to.deep.include({ physicalQuantity: 10, committedQuantity: 0, availableQuantity: 10 })
    expect(findStub.firstCall.args[0]).to.deep.include({
      type: {
        $in: [
          INVENTORY_MOVEMENT_TYPES.SALE_COMMIT,
          INVENTORY_MOVEMENT_TYPES.SALE_CANCEL,
          INVENTORY_MOVEMENT_TYPES.SALE_ADJUSTMENT,
          INVENTORY_MOVEMENT_TYPES.SALE_DELIVERED_OUT
        ]
      }
    })
  })

  it('exposes movement types needed by ledger derivation', () => {
    expect(INVENTORY_MOVEMENT_TYPES.SALE_COMMIT).to.equal('SALE_COMMIT')
    expect(INVENTORY_MOVEMENT_TYPES.SALE_CANCEL).to.equal('SALE_CANCEL')
  })
})
