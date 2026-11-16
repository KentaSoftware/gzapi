import { expect } from 'chai'

import {
  BASELINE_STATUS,
  EXPIRY_TRACKING,
  STOCK_DATA_QUALITY,
  STOCK_ERROR_CODES,
  type AvailabilityInput,
  type FefoAllocationInput,
  type ProductStockRuleContext,
  type StockExpiryEvaluationInput,
  type StockRotationInput
} from '../src/interfaces/stock.interface'
import {
  allocateFefo,
  calculateAvailability,
  evaluateExpiry,
  evaluateLowRotation,
  evaluateLowStock,
  StockRuleError
} from '../src/services/stockRules'

const PRODUCT_ID = '507f1f77bcf86cd799439011'
const OTHER_PRODUCT_ID = '507f1f77bcf86cd799439012'

const completeContext: ProductStockRuleContext = {
  productId: PRODUCT_ID,
  businessDate: '2026-10-15',
  timeZone: 'America/Argentina/Buenos_Aires'
}

describe('Stock rules — availability and FEFO', () => {
  it('calculates non-expired availability without subtracting commitments twice', () => {
    const input: AvailabilityInput = {
      ...completeContext,
      physicalQuantity: 18,
      committedQuantity: 5,
      expiryTracking: EXPIRY_TRACKING.TRACKED,
      baselineStatus: BASELINE_STATUS.RECONCILED,
      expiryBuckets: [
        { bucketId: 'bucket-a', expiryDate: '2026-10-20', availableQuantity: 7, committedQuantity: 3 },
        { bucketId: 'bucket-b', expiryDate: '2026-12-20', availableQuantity: 6, committedQuantity: 2 }
      ]
    }

    expect(calculateAvailability(input)).to.deep.equal({
      productId: PRODUCT_ID,
      availableToSell: 13,
      physicalQuantity: 18,
      committedQuantity: 5,
      expiredQuantity: 0,
      dataQuality: STOCK_DATA_QUALITY.COMPLETE
    })
  })

  it('handles non-tracked stock and zero quantities, but fails closed for unknown or incomplete data', () => {
    expect(calculateAvailability({
      ...completeContext,
      physicalQuantity: 0,
      committedQuantity: 0,
      expiryTracking: EXPIRY_TRACKING.NOT_TRACKED,
      baselineStatus: BASELINE_STATUS.RECONCILED
    })).to.deep.include({ availableToSell: 0, dataQuality: STOCK_DATA_QUALITY.COMPLETE })

    expect(calculateAvailability({
      ...completeContext,
      physicalQuantity: 4,
      committedQuantity: 0,
      expiryTracking: EXPIRY_TRACKING.UNKNOWN,
      baselineStatus: BASELINE_STATUS.RECONCILED
    }).dataQuality).to.equal(STOCK_DATA_QUALITY.INCOMPLETE)

    expect(calculateAvailability({
      ...completeContext,
      physicalQuantity: 4,
      committedQuantity: 0,
      expiryTracking: EXPIRY_TRACKING.NOT_TRACKED,
      baselineStatus: BASELINE_STATUS.UNVERIFIED
    }).dataQuality).to.equal(STOCK_DATA_QUALITY.INCOMPLETE)

    expect(calculateAvailability({
      ...completeContext,
      physicalQuantity: 4,
      committedQuantity: 5,
      expiryTracking: EXPIRY_TRACKING.NOT_TRACKED,
      baselineStatus: BASELINE_STATUS.RECONCILED
    }).dataQuality).to.equal(STOCK_DATA_QUALITY.INCOMPLETE)
  })

  it('fails closed for malformed runtime expiry buckets without throwing', () => {
    const malformedInputs = [
      { ...completeContext, physicalQuantity: 1, committedQuantity: 0, expiryTracking: EXPIRY_TRACKING.NOT_TRACKED, baselineStatus: BASELINE_STATUS.RECONCILED, expiryBuckets: null },
      { ...completeContext, physicalQuantity: 1, committedQuantity: 0, expiryTracking: EXPIRY_TRACKING.TRACKED, baselineStatus: BASELINE_STATUS.RECONCILED, expiryBuckets: [null] },
      { ...completeContext, physicalQuantity: 1, committedQuantity: 0, expiryTracking: EXPIRY_TRACKING.TRACKED, baselineStatus: BASELINE_STATUS.RECONCILED, expiryBuckets: [{}] }
    ]

    for (const input of malformedInputs) {
      expect(calculateAvailability(input as unknown as AvailabilityInput).dataQuality).to.equal(STOCK_DATA_QUALITY.INCOMPLETE)
    }
  })

  it('allocates exact and multi-bucket FEFO quantities in civil-date order', () => {
    const input: FefoAllocationInput = {
      ...completeContext,
      requestedQuantity: 8,
      buckets: [
        { bucketId: 'later', expiryDate: '2026-12-01', availableQuantity: 5, committedQuantity: 0 },
        { bucketId: 'first', expiryDate: '2026-10-20', availableQuantity: 3, committedQuantity: 0 },
        { bucketId: 'middle', expiryDate: '2026-11-01', availableQuantity: 4, committedQuantity: 0 }
      ]
    }

    expect(allocateFefo(input).allocations).to.deep.equal([
      { bucketId: 'first', expiryDate: '2026-10-20', quantity: 3 },
      { bucketId: 'middle', expiryDate: '2026-11-01', quantity: 4 },
      { bucketId: 'later', expiryDate: '2026-12-01', quantity: 1 }
    ])
    expect(allocateFefo({ ...input, requestedQuantity: 0 }).allocations).to.deep.equal([])
  })

  it('rejects insufficient and malformed FEFO input with typed stock errors', () => {
    expect(() => allocateFefo({
      ...completeContext,
      requestedQuantity: 9,
      buckets: [{ bucketId: 'first', expiryDate: '2026-10-20', availableQuantity: 3, committedQuantity: 0 }]
    })).to.throw(StockRuleError).and.have.property('code', STOCK_ERROR_CODES.STOCK_INSUFFICIENT)

    expect(() => allocateFefo({
      ...completeContext,
      requestedQuantity: 1,
      buckets: [{ bucketId: 'first', expiryDate: '2026-10-14', availableQuantity: 3, committedQuantity: 0 }]
    })).to.throw(StockRuleError).and.have.property('code', STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE)
  })
})

describe('Stock rules — expiry, thresholds, and rotation', () => {
  it('SS04-RED S-25/FR-044: treats the printed expiry date as valid through that Buenos Aires business date', () => {
    const input: StockExpiryEvaluationInput = {
      ...completeContext,
      alertDays: 14,
      buckets: [{ bucketId: 'expiry-boundary', expiryDate: '2026-10-15', availableQuantity: 2, committedQuantity: 0 }]
    }

    expect(evaluateExpiry(input)).to.deep.equal([{
      type: 'EXPIRING_SOON',
      severity: 'WARNING',
      productId: PRODUCT_ID,
      explanation: `Product ${PRODUCT_ID} has 2 units expiring on 2026-10-15`,
      dataQuality: STOCK_DATA_QUALITY.COMPLETE
    }])
    expect(evaluateExpiry({ ...input, businessDate: '2026-10-16' })[0]).to.deep.include({ type: 'EXPIRED' })
  })

  it('evaluates expiry boundaries in Buenos Aires without using machine timezone', () => {
    const input: StockExpiryEvaluationInput = {
      ...completeContext,
      alertDays: 14,
      buckets: [
        { bucketId: 'expired', expiryDate: '2026-10-14', availableQuantity: 2, committedQuantity: 0 },
        { bucketId: 'boundary', expiryDate: '2026-10-29', availableQuantity: 3, committedQuantity: 0 },
        { bucketId: 'outside', expiryDate: '2026-10-30', availableQuantity: 4, committedQuantity: 0 },
        { bucketId: 'empty', expiryDate: '2026-10-15', availableQuantity: 0, committedQuantity: 0 }
      ]
    }

    expect(evaluateExpiry(input)).to.deep.equal([
      {
        type: 'EXPIRED',
        severity: 'WARNING',
        productId: PRODUCT_ID,
        explanation: 'Product 507f1f77bcf86cd799439011 has 2 units expired on 2026-10-14',
        dataQuality: STOCK_DATA_QUALITY.COMPLETE
      },
      {
        type: 'EXPIRING_SOON',
        severity: 'WARNING',
        productId: PRODUCT_ID,
        explanation: 'Product 507f1f77bcf86cd799439011 has 3 units expiring on 2026-10-29',
        dataQuality: STOCK_DATA_QUALITY.COMPLETE
      }
    ])
  })

  it('creates low and critical stock alerts using only the configured minimum', () => {
    expect(evaluateLowStock({
      productId: PRODUCT_ID,
      availableToSell: 3,
      physicalQuantity: 3,
      committedQuantity: 0,
      expiredQuantity: 0,
      dataQuality: STOCK_DATA_QUALITY.COMPLETE,
      minimum: 3
    })).to.deep.include({ type: 'LOW_STOCK', severity: 'WARNING', dataQuality: STOCK_DATA_QUALITY.COMPLETE })

    expect(evaluateLowStock({
      productId: PRODUCT_ID,
      availableToSell: 0,
      physicalQuantity: 3,
      committedQuantity: 3,
      expiredQuantity: 0,
      dataQuality: STOCK_DATA_QUALITY.COMPLETE,
      minimum: 3
    })).to.deep.include({ type: 'CRITICAL_STOCK', severity: 'CRITICAL' })

    expect(evaluateLowStock({
      productId: PRODUCT_ID,
      availableToSell: 2,
      physicalQuantity: 2,
      committedQuantity: 0,
      expiredQuantity: 0,
      dataQuality: STOCK_DATA_QUALITY.COMPLETE
    }).dataQuality).to.equal(STOCK_DATA_QUALITY.INCOMPLETE)

    expect(evaluateLowStock({
      productId: PRODUCT_ID,
      availableToSell: 0,
      physicalQuantity: 0,
      committedQuantity: 0,
      expiredQuantity: 0,
      dataQuality: STOCK_DATA_QUALITY.INCOMPLETE,
      minimum: 3
    })).to.deep.include({ type: 'LOW_STOCK', severity: 'WARNING', dataQuality: STOCK_DATA_QUALITY.INCOMPLETE })
  })

  it('distinguishes complete 90-day rotation history from insufficient history', () => {
    const input: StockRotationInput = {
      productId: OTHER_PRODUCT_ID,
      productCreatedAt: '2026-07-16T12:00:00.000Z',
      businessDate: '2026-10-15',
      timeZone: 'America/Argentina/Buenos_Aires',
      rotationDays: 90,
      sales: []
    }
    expect(evaluateLowRotation(input)).to.deep.include({
      productId: OTHER_PRODUCT_ID,
      dataQuality: STOCK_DATA_QUALITY.COMPLETE
    })
    expect(evaluateLowRotation(input).alert?.type).to.equal('LOW_ROTATION')
    expect(evaluateLowRotation({ ...input, productCreatedAt: '2026-10-01T12:00:00.000Z' }).dataQuality).to.equal(STOCK_DATA_QUALITY.INSUFFICIENT_HISTORY)
    expect(evaluateLowRotation({ ...input, sales: [{ occurredAt: 'not-a-date', quantity: 1 }] }).dataQuality).to.equal(STOCK_DATA_QUALITY.INSUFFICIENT_HISTORY)
  })

  it('counts only active, non-cancelled historical sales for rotation', () => {
    const input: StockRotationInput = {
      productId: OTHER_PRODUCT_ID,
      productCreatedAt: '2026-07-16T12:00:00.000Z',
      businessDate: '2026-10-15',
      timeZone: 'America/Argentina/Buenos_Aires',
      rotationDays: 90,
      sales: [
        { occurredAt: '2026-09-01T12:00:00.000Z', quantity: 1, active: true, cancelled: false },
        { occurredAt: '2026-09-02T12:00:00.000Z', quantity: 1, active: true, cancelled: true },
        { occurredAt: '2026-09-03T12:00:00.000Z', quantity: 1, active: false, cancelled: false }
      ]
    }

    expect(evaluateLowRotation(input)).to.deep.include({
      productId: OTHER_PRODUCT_ID,
      dataQuality: STOCK_DATA_QUALITY.COMPLETE,
      validSaleCount: 1
    })
    expect(evaluateLowRotation(input).alert).to.equal(undefined)
    expect(evaluateLowRotation({ ...input, sales: input.sales.slice(1) })).to.deep.include({
      dataQuality: STOCK_DATA_QUALITY.COMPLETE,
      validSaleCount: 0
    })
    expect(evaluateLowRotation({ ...input, sales: input.sales.slice(1) }).alert?.type).to.equal('LOW_ROTATION')
  })

  it('uses the exact 90 complete Buenos Aires civil-day window and aggregates units', () => {
    const input: StockRotationInput = {
      productId: OTHER_PRODUCT_ID,
      productCreatedAt: '2026-07-17T03:00:00.000Z',
      businessDate: '2026-10-15',
      timeZone: 'America/Argentina/Buenos_Aires',
      rotationDays: 90,
      sales: [
        { occurredAt: '2026-07-17T03:00:00.000Z', quantity: 2 },
        { occurredAt: '2026-07-17T02:59:59.000Z', quantity: 100 },
        { occurredAt: '2026-10-14T23:59:59.000Z', quantity: 3 },
        { occurredAt: '2026-10-15T03:00:00.000Z', quantity: 100 }
      ]
    }

    expect(evaluateLowRotation(input)).to.deep.include({
      dataQuality: STOCK_DATA_QUALITY.COMPLETE,
      validSaleCount: 2,
      validSaleQuantity: 5
    })
    expect(evaluateLowRotation({ ...input, sales: input.sales.slice(1, 2) })).to.deep.include({
      dataQuality: STOCK_DATA_QUALITY.COMPLETE,
      validSaleCount: 0,
      validSaleQuantity: 0
    })
    expect(evaluateLowRotation({ ...input, sales: input.sales.slice(1, 2) }).alert?.type).to.equal('LOW_ROTATION')
  })

  it('returns insufficient history for invalid sale status types', () => {
    const input: StockRotationInput = {
      productId: OTHER_PRODUCT_ID,
      productCreatedAt: '2026-07-16T12:00:00.000Z',
      businessDate: '2026-10-15',
      timeZone: 'America/Argentina/Buenos_Aires',
      rotationDays: 90,
      sales: [{ occurredAt: '2026-09-01T12:00:00.000Z', quantity: 1, active: 'yes' } as unknown as StockRotationInput['sales'][number]]
    }

    expect(evaluateLowRotation(input).dataQuality).to.equal(STOCK_DATA_QUALITY.INSUFFICIENT_HISTORY)
  })
})
