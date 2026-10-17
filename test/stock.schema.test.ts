import { expect } from 'chai'
import {
  BASELINE_STATUS,
  EXPIRY_TRACKING,
  INVENTORY_MOVEMENT_TYPES,
  STOCK_DATA_QUALITY,
  STOCK_ERROR_CODES,
  STOCK_OPERATION_STATUSES
} from '../src/interfaces/stock.interface'
import {
  STOCK_EXPIRY_ALERT_DAYS,
  STOCK_ROTATION_DAYS,
  STOCK_RULES_VERSION,
  STOCK_TIME_ZONE
} from '../src/config/stock'
import {
  availabilityQuerySchema,
  productInventoryConfigSchema,
  purchaseReceiptInputSchema,
  stockErrorEnvelopeSchema
} from '../src/schemas/stock.schema'

const PRODUCT_ID = '507f1f77bcf86cd799439011'
const BUY_ID = '507f1f77bcf86cd799439012'
const ITEM_BUY_ID = '507f1f77bcf86cd799439013'
const USER_ID = '507f1f77bcf86cd799439014'

describe('Stock contract — configuration and constants', () => {
  it('exposes the documented deterministic defaults without a runtime feature flag', () => {
    expect(STOCK_TIME_ZONE).to.equal('America/Argentina/Buenos_Aires')
    expect(STOCK_EXPIRY_ALERT_DAYS).to.equal(14)
    expect(STOCK_ROTATION_DAYS).to.equal(90)
    expect(STOCK_RULES_VERSION).to.equal('stock-rules-v1')
    expect(INVENTORY_MOVEMENT_TYPES.SALE_COMMIT).to.equal('SALE_COMMIT')
    expect(STOCK_ERROR_CODES.STOCK_INSUFFICIENT).to.equal('STOCK_INSUFFICIENT')
    expect(STOCK_OPERATION_STATUSES.FAILED_RECOVERABLE).to.equal('FAILED_RECOVERABLE')
    expect(STOCK_DATA_QUALITY.INCOMPLETE).to.equal('INCOMPLETE')
    expect(EXPIRY_TRACKING.UNKNOWN).to.equal('UNKNOWN')
    expect(BASELINE_STATUS.UNVERIFIED).to.equal('UNVERIFIED')
  })
})

describe('Stock contract — purchase receipt schema', () => {
  const validReceipt = {
    buyId: BUY_ID,
    lines: [{
      itemBuyId: ITEM_BUY_ID,
      productId: PRODUCT_ID,
      quantityReceived: 12,
      expiryDate: '2026-12-31'
    }],
    receivedAt: '2026-10-15T12:30:00.000Z',
    operationId: 'stock-receive-2026-10-15-001',
    receivedBy: USER_ID
  }

  it('accepts a complete receipt with positive unit quantities and ISO dates', () => {
    expect(purchaseReceiptInputSchema.safeParse(validReceipt).success).to.equal(true)
  })

  it('rejects zero or fractional received quantities', () => {
    expect(purchaseReceiptInputSchema.safeParse({
      ...validReceipt,
      lines: [{ ...validReceipt.lines[0], quantityReceived: 0 }]
    }).success).to.equal(false)
    expect(purchaseReceiptInputSchema.safeParse({
      ...validReceipt,
      lines: [{ ...validReceipt.lines[0], quantityReceived: 1.5 }]
    }).success).to.equal(false)
  })

  it('rejects malformed ObjectIds, operation IDs, and dates', () => {
    expect(purchaseReceiptInputSchema.safeParse({ ...validReceipt, buyId: 'buy-1' }).success).to.equal(false)
    expect(purchaseReceiptInputSchema.safeParse({ ...validReceipt, receivedBy: 'admin' }).success).to.equal(false)
    expect(purchaseReceiptInputSchema.safeParse({ ...validReceipt, operationId: ' ' }).success).to.equal(false)
    expect(purchaseReceiptInputSchema.safeParse({
      ...validReceipt,
      receivedAt: '2026-02-30T12:30:00.000Z'
    }).success).to.equal(false)
    expect(purchaseReceiptInputSchema.safeParse({
      ...validReceipt,
      lines: [{ ...validReceipt.lines[0], expiryDate: '2026-02-30' }]
    }).success).to.equal(false)
  })

  it('rejects unknown keys at the receipt and line boundaries', () => {
    expect(purchaseReceiptInputSchema.safeParse({ ...validReceipt, unexpected: true }).success).to.equal(false)
    expect(purchaseReceiptInputSchema.safeParse({
      ...validReceipt,
      lines: [{ ...validReceipt.lines[0], unexpected: true }]
    }).success).to.equal(false)
  })
})

describe('Stock contract — query, inventory config, and error envelope schemas', () => {
  it('validates availability product IDs and rejects unknown query keys', () => {
    expect(availabilityQuerySchema.safeParse({ productIds: [PRODUCT_ID] }).success).to.equal(true)
    expect(availabilityQuerySchema.safeParse({ productIds: ['not-an-object-id'] }).success).to.equal(false)
    expect(availabilityQuerySchema.safeParse({ productIds: [PRODUCT_ID], extra: true }).success).to.equal(false)
  })

  it('validates inventory tracking and baseline enums', () => {
    expect(productInventoryConfigSchema.safeParse({
      minimum: 5,
      expiryTracking: 'TRACKED',
      baselineStatus: 'RECONCILED',
      lastReconciledAt: '2026-10-15T12:30:00.000Z',
      lastReconciledBy: USER_ID
    }).success).to.equal(true)
    expect(productInventoryConfigSchema.safeParse({
      minimum: 5,
      expiryTracking: 'OPTIONAL',
      baselineStatus: 'RECONCILED'
    }).success).to.equal(false)
  })

  it('keeps stock errors stable and strict', () => {
    expect(stockErrorEnvelopeSchema.safeParse({
      code: 'STOCK_INSUFFICIENT',
      message: 'Insufficient stock',
      correlationId: 'request-123'
    }).success).to.equal(true)
    expect(stockErrorEnvelopeSchema.safeParse({
      code: 'NOT_A_STOCK_ERROR',
      message: 'Invalid'
    }).success).to.equal(false)
    expect(stockErrorEnvelopeSchema.safeParse({
      code: 'STOCK_INSUFFICIENT',
      message: 'Invalid',
      extra: true
    }).success).to.equal(false)
  })
})
