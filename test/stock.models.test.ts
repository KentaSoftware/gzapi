import { expect } from 'chai'
import { Types } from 'mongoose'

import InventoryMovementModel from '../src/models/inventoryMovement'
import StockExpiryBucketModel from '../src/models/stockExpiryBucket'
import { INVENTORY_MOVEMENT_TYPES } from '../src/interfaces/stock.interface'

const PRODUCT_ID = new Types.ObjectId()
const BUCKET_ID = new Types.ObjectId()
const ACTOR_ID = new Types.ObjectId()
const SOURCE_LINE_ID = new Types.ObjectId()
const REVERSAL_ID = new Types.ObjectId()

const validMovement = {
  productId: PRODUCT_ID,
  expiryBucketId: BUCKET_ID,
  type: INVENTORY_MOVEMENT_TYPES.PURCHASE_IN,
  quantity: 12,
  occurredAt: new Date('2026-10-15T12:30:00.000Z'),
  sourceType: 'purchase',
  sourceId: 'buy-123',
  sourceEvent: 'purchase.received',
  operationId: 'operation-123',
  idempotencyKey: 'operation-123:line-1:purchase.received',
  rulesVersion: 'stock-rules-v1',
  sourceLineId: SOURCE_LINE_ID,
  reason: 'Complete receipt',
  reversesMovementId: REVERSAL_ID,
  createdBy: ACTOR_ID
}

const validBucket = {
  productId: PRODUCT_ID,
  expiryDate: new Date('2026-10-15T18:30:00.000Z'),
  receivedQuantity: 20,
  availableQuantity: 12,
  committedQuantity: 8
}

function hasIndex (schema: typeof InventoryMovementModel.schema, fields: Record<string, 1 | -1>, unique = false): boolean {
  return schema.indexes().some(([indexFields, options]) => {
    return JSON.stringify(indexFields) === JSON.stringify(fields) && (unique ? options.unique === true : options.unique !== true)
  })
}

describe('Stock model — inventory movement', () => {
  it('defines required references, bounded source fields, enum type, and positive integer quantity', () => {
    const missing = new InventoryMovementModel()
    const missingError = missing.validateSync()

    expect(missingError?.errors.productId).to.not.equal(undefined)
    expect(missingError?.errors.type).to.not.equal(undefined)
    expect(missingError?.errors.quantity).to.not.equal(undefined)
    expect(missingError?.errors.occurredAt).to.not.equal(undefined)
    expect(missingError?.errors.sourceType).to.not.equal(undefined)
    expect(missingError?.errors.sourceId).to.not.equal(undefined)
    expect(missingError?.errors.sourceEvent).to.not.equal(undefined)
    expect(missingError?.errors.operationId).to.not.equal(undefined)
    expect(missingError?.errors.idempotencyKey).to.not.equal(undefined)
    expect(missingError?.errors.rulesVersion).to.not.equal(undefined)
    expect(missingError?.errors.createdBy).to.not.equal(undefined)

    const valid = new InventoryMovementModel(validMovement)
    expect(valid.validateSync()).to.equal(undefined)
    expect(InventoryMovementModel.schema.path('productId').options.ref).to.equal('product')
    expect(InventoryMovementModel.schema.path('expiryBucketId').options.ref).to.equal('stockExpiryBucket')
    expect(InventoryMovementModel.schema.path('createdBy').options.ref).to.equal('user')

    const invalidType = new InventoryMovementModel({ ...validMovement, type: 'NOT_A_MOVEMENT' })
    expect(invalidType.validateSync()?.errors.type).to.not.equal(undefined)

    const overlongSourceType = new InventoryMovementModel({ ...validMovement, sourceType: 'x'.repeat(65) })
    expect(overlongSourceType.validateSync()?.errors.sourceType).to.not.equal(undefined)
  })

  it('rejects zero, negative, and fractional movement quantities', () => {
    for (const quantity of [0, -1, 1.5]) {
      const movement = new InventoryMovementModel({ ...validMovement, quantity })
      expect(movement.validateSync()?.errors.quantity, `quantity ${quantity} should be rejected`).to.not.equal(undefined)
    }
  })

  it('uses timestamps and disables the version key', () => {
    expect(InventoryMovementModel.schema.options.timestamps).to.equal(true)
    expect(InventoryMovementModel.schema.options.versionKey).to.equal(false)
    expect(InventoryMovementModel.schema.path('createdAt')).to.not.equal(undefined)
    expect(InventoryMovementModel.schema.path('updatedAt')).to.not.equal(undefined)
  })

  it('declares every required named index', () => {
    const indexes = InventoryMovementModel.schema.indexes()
    const namedIndexes = indexes.map(([, options]) => options.name)

    expect(namedIndexes).to.include('idx_inventory_movement_idempotency_unique')
    expect(namedIndexes).to.include('idx_inventory_movement_product_occurred_at')
    expect(namedIndexes).to.include('idx_inventory_movement_expiry_bucket_occurred_at')
    expect(namedIndexes).to.include('idx_inventory_movement_source')
    expect(hasIndex(InventoryMovementModel.schema, { idempotencyKey: 1 }, true)).to.equal(true)
    expect(hasIndex(InventoryMovementModel.schema, { productId: 1, occurredAt: -1 })).to.equal(true)
    expect(hasIndex(InventoryMovementModel.schema, { expiryBucketId: 1, occurredAt: -1 })).to.equal(true)
    expect(hasIndex(InventoryMovementModel.schema, { sourceType: 1, sourceId: 1 })).to.equal(true)
  })
})

describe('Stock model — expiry bucket', () => {
  it('defines required product, date, and non-negative integer quantities', () => {
    const missing = new StockExpiryBucketModel()
    const missingError = missing.validateSync()

    expect(missingError?.errors.productId).to.not.equal(undefined)
    expect(missingError?.errors.expiryDate).to.not.equal(undefined)
    expect(missingError?.errors.receivedQuantity).to.not.equal(undefined)
    expect(missingError?.errors.availableQuantity).to.not.equal(undefined)
    expect(missingError?.errors.committedQuantity).to.not.equal(undefined)

    const valid = new StockExpiryBucketModel(validBucket)
    expect(valid.validateSync()).to.equal(undefined)
    expect(valid.expiryDate.toISOString()).to.equal('2026-10-15T00:00:00.000Z')
    expect(StockExpiryBucketModel.schema.path('productId').options.ref).to.equal('product')
  })

  it('normalizes timestamps using the Buenos Aires civil date', () => {
    const nearUtcMidnight = new StockExpiryBucketModel({
      ...validBucket,
      expiryDate: new Date('2026-10-16T02:30:00.000Z')
    })

    expect(nearUtcMidnight.validateSync()).to.equal(undefined)
    expect(nearUtcMidnight.expiryDate.toISOString()).to.equal('2026-10-15T00:00:00.000Z')
  })

  it('rejects negative and fractional bucket quantities but accepts zero', () => {
    const zeroQuantities = new StockExpiryBucketModel({
      ...validBucket,
      receivedQuantity: 0,
      availableQuantity: 0,
      committedQuantity: 0
    })
    expect(zeroQuantities.validateSync()).to.equal(undefined)

    for (const field of ['receivedQuantity', 'availableQuantity', 'committedQuantity'] as const) {
      for (const quantity of [-1, 1.5]) {
        const bucket = new StockExpiryBucketModel({ ...validBucket, [field]: quantity })
        expect(bucket.validateSync()?.errors[field], `${field} ${quantity} should be rejected`).to.not.equal(undefined)
      }
    }
  })

  it('uses timestamps and disables the version key', () => {
    expect(StockExpiryBucketModel.schema.options.timestamps).to.equal(true)
    expect(StockExpiryBucketModel.schema.options.versionKey).to.equal(false)
    expect(StockExpiryBucketModel.schema.path('createdAt')).to.not.equal(undefined)
    expect(StockExpiryBucketModel.schema.path('updatedAt')).to.not.equal(undefined)
  })

  it('declares unique product/date and expiry-date query indexes with stable names', () => {
    const indexes = StockExpiryBucketModel.schema.indexes()
    const namedIndexes = indexes.map(([, options]) => options.name)

    expect(namedIndexes).to.include('idx_stock_expiry_bucket_product_expiry_unique')
    expect(namedIndexes).to.include('idx_stock_expiry_bucket_expiry_product')
    expect(indexes.some(([fields, options]) => {
      return JSON.stringify(fields) === JSON.stringify({ productId: 1, expiryDate: 1 }) &&
        options.unique === true && options.name === 'idx_stock_expiry_bucket_product_expiry_unique'
    })).to.equal(true)
    expect(indexes.some(([fields, options]) => {
      return JSON.stringify(fields) === JSON.stringify({ expiryDate: 1, productId: 1 }) &&
        options.unique !== true && options.name === 'idx_stock_expiry_bucket_expiry_product'
    })).to.equal(true)
  })
})
