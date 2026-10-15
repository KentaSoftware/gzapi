import { expect } from 'chai'

import {
  BASELINE_STATUS,
  EXPIRY_TRACKING,
  INVENTORY_MOVEMENT_TYPES,
  STOCK_DATA_QUALITY,
  STOCK_ERROR_CODES,
  STOCK_OPERATION_STATUSES,
  type InventoryMovementType,
  type StockBucketSnapshot,
  type StockMovementRecord,
  type PurchaseReceiptInput,
  type SaleDeliveryInput,
  type StockProductSnapshot,
  type StockRepository,
  type StockRepositorySession,
  type StockServiceAuth,
  type StockTransactionContext
} from '../src/interfaces/stock.interface'
import { StockService, StockServiceError } from '../src/services/stock'

const PRODUCT_ID = 'product-1'
const UNTRACKED_PRODUCT_ID = 'product-2'
const ACTOR: StockServiceAuth = { actorId: 'actor-1', canManageStock: false }
const DATE = '2026-10-15'

class MemoryRepository implements StockRepository {
  products = new Map<string, StockProductSnapshot>()
  buckets = new Map<string, StockBucketSnapshot>()
  movements: StockMovementRecord[] = []
  transactionCalls = 0
  projectionSessions: Array<{ method: string, session: StockRepositorySession | undefined }> = []
  receiptSessions: StockRepositorySession[] = []
  private movementSequence = 0

  async withTransaction<T> (work: (context: StockTransactionContext) => Promise<T>): Promise<T> {
    this.transactionCalls += 1
    const session: StockRepositorySession = { transactionId: `tx-${this.transactionCalls}` }
    return await work(Object.assign(this, { session }))
  }

  async getProduct (productId: string): Promise<StockProductSnapshot | undefined> {
    return this.products.get(productId)
  }

  async getBuckets (productId: string): Promise<StockBucketSnapshot[]> {
    return [...this.buckets.values()].filter((bucket) => bucket.productId === productId)
  }

  async findMovementByIdempotencyKey (idempotencyKey: string): Promise<StockMovementRecord | undefined> {
    return this.movements.find((movement) => movement.idempotencyKey === idempotencyKey)
  }

  async findMovements (query: { sourceType?: string, sourceId?: string, type?: InventoryMovementType }): Promise<StockMovementRecord[]> {
    return this.movements.filter((movement) =>
      (query.sourceType === undefined || movement.sourceType === query.sourceType) &&
      (query.sourceId === undefined || movement.sourceId === query.sourceId) &&
      (query.type === undefined || movement.type === query.type))
  }

  async insertMovement (movement: StockMovementRecord): Promise<StockMovementRecord> {
    const inserted = { ...movement, movementId: movement.movementId ?? `movement-${++this.movementSequence}` }
    this.movements.push(inserted)
    return inserted
  }

  async applyBucketProjectionDelta (bucketId: string, delta: { availableQuantityDelta: number, committedQuantityDelta: number, receivedQuantityDelta?: number }, session?: StockRepositorySession): Promise<void> {
    this.projectionSessions.push({ method: 'bucket', session })
    const bucket = this.buckets.get(bucketId)
    if (bucket === undefined) throw new Error(`Missing bucket ${bucketId}`)
    this.buckets.set(bucketId, {
      ...bucket,
      receivedQuantity: bucket.receivedQuantity + (delta.receivedQuantityDelta ?? 0),
      availableQuantity: bucket.availableQuantity + delta.availableQuantityDelta,
      committedQuantity: bucket.committedQuantity + delta.committedQuantityDelta
    })
  }

  async applyPhysicalBucketReceipt (productId: string, expiryDate: string, quantity: number, session?: StockRepositorySession): Promise<StockBucketSnapshot> {
    if (session !== undefined) this.receiptSessions.push(session)
    const bucketId = `bucket-${productId}-${expiryDate}`
    const existing = [...this.buckets.values()].find((entry) => entry.productId === productId && entry.expiryDate === expiryDate)
    const next = existing === undefined
      ? {
          bucketId,
          productId,
          expiryDate,
          receivedQuantity: quantity,
          availableQuantity: quantity,
          committedQuantity: 0
        }
      : {
          ...existing,
          receivedQuantity: existing.receivedQuantity + quantity,
          availableQuantity: existing.availableQuantity + quantity
        }
    this.buckets.set(next.bucketId, next)
    return next
  }

  async applyProductProjectionDelta (productId: string, delta: { availableQuantityDelta: number, committedQuantityDelta: number, physicalQuantityDelta: number }, session?: StockRepositorySession): Promise<void> {
    this.projectionSessions.push({ method: 'product', session })
    const product = this.products.get(productId)
    if (product === undefined) throw new Error(`Missing product ${productId}`)
    this.products.set(productId, {
      ...product,
      committedQuantity: product.committedQuantity + delta.committedQuantityDelta,
      availableQuantity: product.availableQuantity + delta.availableQuantityDelta,
      physicalQuantity: product.physicalQuantity + delta.physicalQuantityDelta
    })
  }
}

const trackedProduct = (): StockProductSnapshot => ({
  productId: PRODUCT_ID,
  physicalQuantity: 10,
  committedQuantity: 0,
  availableQuantity: 10,
  expiryTracking: EXPIRY_TRACKING.TRACKED,
  baselineStatus: BASELINE_STATUS.RECONCILED
})

const untrackedProduct = (): StockProductSnapshot => ({
  productId: UNTRACKED_PRODUCT_ID,
  physicalQuantity: 10,
  committedQuantity: 0,
  availableQuantity: 10,
  expiryTracking: EXPIRY_TRACKING.NOT_TRACKED,
  baselineStatus: BASELINE_STATUS.RECONCILED
})

const bucket = (bucketId: string, expiryDate: string, availableQuantity: number, committedQuantity = 0): StockBucketSnapshot => ({
  bucketId,
  productId: PRODUCT_ID,
  expiryDate,
  receivedQuantity: availableQuantity + committedQuantity,
  availableQuantity,
  committedQuantity
})

const newRepository = (): MemoryRepository => {
  const repository = new MemoryRepository()
  repository.products.set(PRODUCT_ID, trackedProduct())
  repository.products.set(UNTRACKED_PRODUCT_ID, untrackedProduct())
  repository.buckets.set('bucket-first', bucket('bucket-first', '2026-10-20', 4))
  repository.buckets.set('bucket-later', bucket('bucket-later', '2026-12-20', 6))
  return repository
}

const expectRejected = async (action: () => Promise<unknown>, code?: string): Promise<void> => {
  try {
    await action()
    expect.fail('Expected the operation to reject')
  } catch (error) {
    expect(error).to.be.instanceOf(StockServiceError)
    if (code !== undefined) expect(error).to.have.property('code', code)
  }
}

describe('Stock service', () => {
  it('reads availability without writing and reports incomplete snapshots', async () => {
    const repository = newRepository()
    const service = new StockService(repository)

    const result = await service.getAvailability({ productIds: [PRODUCT_ID, 'missing'], businessDate: DATE, auth: ACTOR })

    expect(result[0]).to.deep.include({ productId: PRODUCT_ID, availableToSell: 10, dataQuality: STOCK_DATA_QUALITY.COMPLETE })
    expect(result[1]).to.deep.include({ productId: 'missing', dataQuality: STOCK_DATA_QUALITY.INCOMPLETE })
    expect(repository.movements).to.have.length(0)
  })

  it('aggregates duplicate lines and fails closed for insufficient or unavailable stock', async () => {
    const repository = newRepository()
    const service = new StockService(repository)

    const validation = await service.assertSaleAvailability({
      saleId: 'sale-1',
      businessDate: DATE,
      auth: ACTOR,
      lines: [
        { lineId: 'line-a', productId: PRODUCT_ID, quantity: 2 },
        { lineId: 'line-b', productId: PRODUCT_ID, quantity: 3 }
      ]
    })
    expect(validation.lines).to.deep.equal([{ productId: PRODUCT_ID, quantity: 5 }])

    await expectRejected(async () => await service.assertSaleAvailability({
      saleId: 'sale-2', businessDate: DATE, auth: ACTOR, lines: [{ lineId: 'line-a', productId: PRODUCT_ID, quantity: 11 }]
    }))
    await expectRejected(async () => await service.assertSaleAvailability({ saleId: 'sale-3', businessDate: DATE, auth: ACTOR, lines: [{ lineId: 'line-a', productId: 'missing', quantity: 1 }] }), STOCK_ERROR_CODES.STOCK_AVAILABILITY_UNAVAILABLE)
    expect(repository.movements).to.have.length(0)
  })

  it('commits tracked lines with FEFO allocations and leaves physical stock unchanged', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    const result = await service.commitSale({
      saleId: 'sale-1',
      operationId: 'operation-1',
      businessDate: DATE,
      auth: ACTOR,
      lines: [{ lineId: 'line-1', productId: PRODUCT_ID, quantity: 7 }]
    })

    expect(result).to.include({ status: STOCK_OPERATION_STATUSES.APPLIED, movementCount: 2, appliedMovementCount: 2, alreadyAppliedCount: 0 })
    expect(repository.movements.map(({ type, quantity, expiryBucketId }) => ({ type, quantity, expiryBucketId }))).to.deep.equal([
      { type: INVENTORY_MOVEMENT_TYPES.SALE_COMMIT, quantity: 4, expiryBucketId: 'bucket-first' },
      { type: INVENTORY_MOVEMENT_TYPES.SALE_COMMIT, quantity: 3, expiryBucketId: 'bucket-later' }
    ])
    expect(repository.products.get(PRODUCT_ID)?.physicalQuantity).to.equal(10)
    expect(repository.products.get(PRODUCT_ID)?.committedQuantity).to.equal(7)
    expect(repository.buckets.get('bucket-first')?.availableQuantity).to.equal(0)
    expect(repository.buckets.get('bucket-first')?.committedQuantity).to.equal(4)
    expect(repository.transactionCalls).to.equal(1)
    expect(repository.projectionSessions).to.have.length(4)
    expect(repository.projectionSessions.every(({ session }) => session?.transactionId === 'tx-1')).to.equal(true)
  })

  it('filters expired buckets from FEFO while retaining them in projections', async () => {
    const repository = newRepository()
    repository.buckets.clear()
    repository.buckets.set('bucket-expired', bucket('bucket-expired', '2026-10-10', 8))
    repository.buckets.set('bucket-valid', bucket('bucket-valid', '2026-10-20', 2))
    const service = new StockService(repository)

    const result = await service.commitSale({
      saleId: 'sale-expiry',
      operationId: 'operation-expiry',
      businessDate: DATE,
      auth: ACTOR,
      lines: [{ lineId: 'line-1', productId: PRODUCT_ID, quantity: 2 }]
    })

    expect(result.appliedMovementCount).to.equal(1)
    expect(repository.movements[0]).to.include({ expiryBucketId: 'bucket-valid', quantity: 2 })
    expect(repository.buckets.get('bucket-expired')).to.deep.include({ availableQuantity: 8, committedQuantity: 0 })
  })

  it('commits non-tracked lines without inventing buckets and preserves idempotency', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    const input = {
      saleId: 'sale-2',
      operationId: 'operation-2',
      businessDate: DATE,
      auth: ACTOR,
      lines: [{ lineId: 'line-1', productId: UNTRACKED_PRODUCT_ID, quantity: 3 }]
    }

    const first = await service.commitSale(input)
    const second = await service.commitSale(input)
    expect(first.movementCount).to.equal(1)
    expect(second).to.include({ movementCount: 0, appliedMovementCount: 0, alreadyAppliedCount: 1 })
    expect(repository.movements[0].expiryBucketId).to.equal(undefined)
    expect(repository.products.get(UNTRACKED_PRODUCT_ID)?.physicalQuantity).to.equal(10)
  })

  it('rejects conflicting idempotency and cancels commitments with compensations', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    await service.commitSale({
      saleId: 'sale-3',
      operationId: 'operation-3',
      businessDate: DATE,
      auth: ACTOR,
      lines: [{ lineId: 'line-1', productId: PRODUCT_ID, quantity: 2 }]
    })

    await expectRejected(async () => await service.commitSale({
      saleId: 'sale-3',
      operationId: 'operation-3',
      businessDate: DATE,
      auth: ACTOR,
      lines: [{ lineId: 'line-1', productId: PRODUCT_ID, quantity: 3 }]
    }))
    const cancelled = await service.cancelSale({ saleId: 'sale-3', operationId: 'cancel-3', businessDate: DATE, auth: ACTOR })
    const retried = await service.cancelSale({ saleId: 'sale-3', operationId: 'cancel-3', businessDate: DATE, auth: ACTOR })

    expect(cancelled).to.include({ movementCount: 1, appliedMovementCount: 1 })
    expect(retried).to.include({ movementCount: 0, alreadyAppliedCount: 1 })
    expect(repository.products.get(PRODUCT_ID)?.physicalQuantity).to.equal(10)
    expect(repository.products.get(PRODUCT_ID)?.committedQuantity).to.equal(0)
    expect(repository.buckets.get('bucket-first')?.availableQuantity).to.equal(4)
    expect(repository.buckets.get('bucket-first')?.committedQuantity).to.equal(0)
  })

  it('does not treat a new operation as an already-applied commitment', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    const line = { lineId: 'line-1', productId: PRODUCT_ID, quantity: 10 }

    await service.commitSale({ saleId: 'sale-idempotency', operationId: 'operation-first', businessDate: DATE, auth: ACTOR, lines: [line] })
    await expectRejected(async () => await service.commitSale({
      saleId: 'sale-idempotency',
      operationId: 'operation-second',
      businessDate: DATE,
      auth: ACTOR,
      lines: [line]
    }), STOCK_ERROR_CODES.STOCK_INSUFFICIENT)
  })

  it('does not treat a new adjustment operation as already applied', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    const addition = { lineId: 'line-1', productId: PRODUCT_ID, quantity: 10 }

    await service.adjustSale({ saleId: 'sale-adjustment-idempotency', operationId: 'adjustment-first', businessDate: DATE, auth: ACTOR, additions: [addition] })
    await expectRejected(async () => await service.adjustSale({
      saleId: 'sale-adjustment-idempotency',
      operationId: 'adjustment-second',
      businessDate: DATE,
      auth: ACTOR,
      additions: [addition]
    }), STOCK_ERROR_CODES.STOCK_INSUFFICIENT)
  })

  it('rejects retries with a different actor or rules version as semantic conflicts', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    const input = {
      saleId: 'sale-semantic',
      operationId: 'operation-semantic',
      businessDate: DATE,
      auth: ACTOR,
      lines: [{ lineId: 'line-1', productId: PRODUCT_ID, quantity: 2 }]
    }

    await service.commitSale(input)
    await expectRejected(async () => await service.commitSale({ ...input, auth: { actorId: 'actor-2', canManageStock: false } }), STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT)
    await expectRejected(async () => await new StockService(repository, { rulesVersion: 'different-rules' }).commitSale(input), STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT)
  })

  it('requires explicit adjustment additions or releases and supports both paths', async () => {
    const repository = newRepository()
    const service = new StockService(repository)

    await expectRejected(async () => await service.adjustSale({ saleId: 'sale-4', operationId: 'adjust-1', businessDate: DATE, auth: ACTOR }))
    await service.commitSale({
      saleId: 'sale-4',
      operationId: 'commit-4',
      businessDate: DATE,
      auth: ACTOR,
      lines: [{ lineId: 'line-1', productId: PRODUCT_ID, quantity: 2 }]
    })
    const added = await service.adjustSale({
      saleId: 'sale-4',
      operationId: 'adjust-1',
      businessDate: DATE,
      auth: ACTOR,
      additions: [{ lineId: 'line-1', productId: PRODUCT_ID, quantity: 2 }]
    })
    const released = await service.adjustSale({
      saleId: 'sale-4',
      operationId: 'adjust-2',
      businessDate: DATE,
      auth: ACTOR,
      releases: [{ lineId: 'line-1', productId: PRODUCT_ID, quantity: 1, bucketId: 'bucket-first' }]
    })

    expect(added.movementCount).to.equal(1)
    expect(released.movementCount).to.equal(1)
    expect(repository.products.get(PRODUCT_ID)?.physicalQuantity).to.equal(10)
  })

  it('rejects releasing a bucket committed by another sale', async () => {
    const repository = newRepository()
    const service = new StockService(repository)

    await service.commitSale({
      saleId: 'sale-owner',
      operationId: 'operation-owner',
      businessDate: DATE,
      auth: ACTOR,
      lines: [{ lineId: 'owner-line', productId: PRODUCT_ID, quantity: 2 }]
    })

    await expectRejected(async () => await service.adjustSale({
      saleId: 'sale-other',
      operationId: 'operation-release',
      businessDate: DATE,
      auth: ACTOR,
      releases: [{ lineId: 'other-line', productId: PRODUCT_ID, quantity: 1, bucketId: 'bucket-first' }]
    }), STOCK_ERROR_CODES.STOCK_INSUFFICIENT)
  })

  it('fails closed when the actor is missing', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    await expectRejected(async () => await service.commitSale({
      saleId: 'sale-5',
      operationId: 'operation-5',
      businessDate: DATE,
      auth: { actorId: '', canManageStock: true },
      lines: [{ lineId: 'line-1', productId: PRODUCT_ID, quantity: 1 }]
    }), STOCK_ERROR_CODES.STOCK_FORBIDDEN)
    expect(repository.transactionCalls).to.equal(0)
  })

  it('receives tracked purchase lines into buckets and physical stock without commitments', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    const input: PurchaseReceiptInput = {
      buyId: 'buy-1',
      lines: [{ itemBuyId: 'item-buy-1', productId: PRODUCT_ID, quantityReceived: 3, expiryDate: '2026-11-01' }],
      receivedAt: '2026-10-15T12:00:00.000Z',
      operationId: 'receipt-1',
      receivedBy: 'actor-1'
    }

    const result = await service.receivePurchase(input)

    expect(result.appliedMovementCount).to.equal(1)
    expect(repository.products.get(PRODUCT_ID)).to.deep.include({ physicalQuantity: 13, committedQuantity: 0, availableQuantity: 13 })
    expect([...repository.buckets.values()]).to.have.deep.include({
      bucketId: 'bucket-product-1-2026-11-01',
      productId: PRODUCT_ID,
      expiryDate: '2026-11-01',
      receivedQuantity: 3,
      availableQuantity: 3,
      committedQuantity: 0
    })
    expect(repository.movements[0]).to.include({
      type: INVENTORY_MOVEMENT_TYPES.PURCHASE_IN,
      sourceType: 'PURCHASE',
      sourceId: 'buy-1',
      sourceEvent: 'PURCHASE_RECEIPT',
      operationId: 'receipt-1',
      createdBy: 'actor-1'
    })
    expect(repository.receiptSessions).to.deep.equal([{ transactionId: 'tx-1' }])
    expect(repository.projectionSessions).to.deep.equal([{ method: 'product', session: { transactionId: 'tx-1' } }])
  })

  it('receives non-tracked purchase lines physically and rejects expiry dates', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    const input: PurchaseReceiptInput = {
      buyId: 'buy-2',
      lines: [{ itemBuyId: 'item-buy-2', productId: UNTRACKED_PRODUCT_ID, quantityReceived: 4 }],
      receivedAt: '2026-10-15T12:00:00.000Z',
      operationId: 'receipt-2',
      receivedBy: 'actor-1'
    }

    await service.receivePurchase(input)
    expect(repository.products.get(UNTRACKED_PRODUCT_ID)).to.deep.include({ physicalQuantity: 14, committedQuantity: 0, availableQuantity: 14 })
    expect(repository.buckets).to.have.property('size', 2)
    await expectRejected(async () => await service.receivePurchase({
      ...input,
      operationId: 'receipt-3',
      lines: [{ ...input.lines[0], expiryDate: '2026-11-01' }]
    }), STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE)
  })

  it('rejects invalid receipt identity, quantities, expiry, and unknown tracking before writing', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    const base: PurchaseReceiptInput = {
      buyId: 'buy-invalid',
      lines: [{ itemBuyId: 'item-invalid', productId: PRODUCT_ID, quantityReceived: 1, expiryDate: '2026-11-01' }],
      receivedAt: '2026-10-15T12:00:00.000Z',
      operationId: 'receipt-invalid',
      receivedBy: 'actor-1'
    }

    await expectRejected(async () => await service.receivePurchase({ ...base, receivedBy: '' }), STOCK_ERROR_CODES.STOCK_FORBIDDEN)
    await expectRejected(async () => await service.receivePurchase({ ...base, lines: [] }), STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE)
    await expectRejected(async () => await service.receivePurchase({ ...base, lines: [{ ...base.lines[0], quantityReceived: 0 }] }), STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE)
    await expectRejected(async () => await service.receivePurchase({ ...base, lines: [{ ...base.lines[0], expiryDate: '2026-02-30' }] }), STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE)
    repository.products.set('unknown-tracking', { ...trackedProduct(), productId: 'unknown-tracking', expiryTracking: EXPIRY_TRACKING.UNKNOWN })
    await expectRejected(async () => await service.receivePurchase({ ...base, lines: [{ ...base.lines[0], productId: 'unknown-tracking' }] }), STOCK_ERROR_CODES.STOCK_AVAILABILITY_UNAVAILABLE)
    expect(repository.movements).to.have.length(0)
  })

  it('makes matching receipt retries no-ops and conflicting retries fail closed', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    const input: PurchaseReceiptInput = {
      buyId: 'buy-retry',
      lines: [{ itemBuyId: 'item-retry', productId: PRODUCT_ID, quantityReceived: 2, expiryDate: '2026-11-01' }],
      receivedAt: '2026-10-15T12:00:00.000Z',
      operationId: 'receipt-retry',
      receivedBy: 'actor-1'
    }

    const first = await service.receivePurchase(input)
    const second = await service.receivePurchase(input)
    expect(first.appliedMovementCount).to.equal(1)
    expect(second).to.include({ appliedMovementCount: 0, alreadyAppliedCount: 1 })
    expect(repository.products.get(PRODUCT_ID)?.physicalQuantity).to.equal(12)
    await expectRejected(async () => await service.receivePurchase({ ...input, lines: [{ ...input.lines[0], quantityReceived: 3 }] }), STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT)
  })

  it('delivers tracked commitments once while preserving available quantities', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    await service.commitSale({ saleId: 'sale-delivery', operationId: 'commit-delivery', businessDate: DATE, auth: ACTOR, lines: [{ lineId: 'line-delivery', productId: PRODUCT_ID, quantity: 3 }] })
    const input: SaleDeliveryInput = { saleId: 'sale-delivery', deliveredAt: '2026-10-15T13:00:00.000Z', operationId: 'delivery-1', deliveredBy: 'actor-1' }
    repository.projectionSessions = []

    const first = await service.deliverSale(input)
    const second = await service.deliverSale(input)

    expect(first.appliedMovementCount).to.equal(1)
    expect(second.appliedMovementCount).to.equal(0)
    expect(second.alreadyAppliedCount).to.equal(1)
    expect(repository.products.get(PRODUCT_ID)).to.deep.include({ physicalQuantity: 7, committedQuantity: 0, availableQuantity: 7 })
    expect(repository.buckets.get('bucket-first')).to.deep.include({ receivedQuantity: 1, availableQuantity: 1, committedQuantity: 0 })
    expect(repository.movements.filter(({ type }) => type === INVENTORY_MOVEMENT_TYPES.SALE_DELIVERED_OUT)).to.have.length(1)
    expect(repository.movements.find(({ type }) => type === INVENTORY_MOVEMENT_TYPES.SALE_DELIVERED_OUT)).to.include({ operationId: 'delivery-1', createdBy: 'actor-1', sourceEvent: 'SALE_DELIVERY' })
    expect(repository.projectionSessions).to.have.length(2)
    expect(repository.projectionSessions.every(({ session }) => session?.transactionId === 'tx-2')).to.equal(true)
  })

  it('delivers non-tracked commitments by closing the ledger commitment and physical stock', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    await service.commitSale({ saleId: 'sale-untracked-delivery', operationId: 'commit-untracked-delivery', businessDate: DATE, auth: ACTOR, lines: [{ lineId: 'line-delivery', productId: UNTRACKED_PRODUCT_ID, quantity: 3 }] })
    const input: SaleDeliveryInput = { saleId: 'sale-untracked-delivery', deliveredAt: '2026-10-15T13:00:00.000Z', operationId: 'delivery-untracked', deliveredBy: 'actor-1' }

    await service.deliverSale(input)

    expect(repository.products.get(UNTRACKED_PRODUCT_ID)).to.deep.include({ physicalQuantity: 7, committedQuantity: 0, availableQuantity: 7 })
    expect(repository.movements).to.have.length(2)
    expect(repository.movements[1]).to.include({ type: INVENTORY_MOVEMENT_TYPES.SALE_DELIVERED_OUT, quantity: 3, reversesMovementId: repository.movements[0].movementId })
  })

  it('does not consume cancelled or already delivered commitments', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    await service.commitSale({ saleId: 'sale-cancelled', operationId: 'commit-cancelled', businessDate: DATE, auth: ACTOR, lines: [{ lineId: 'line-cancelled', productId: PRODUCT_ID, quantity: 2 }] })
    await service.cancelSale({ saleId: 'sale-cancelled', operationId: 'cancel-cancelled', businessDate: DATE, auth: ACTOR })
    const cancelledDelivery = await service.deliverSale({ saleId: 'sale-cancelled', deliveredAt: '2026-10-15T13:00:00.000Z', operationId: 'delivery-cancelled', deliveredBy: 'actor-1' })
    expect(cancelledDelivery.appliedMovementCount).to.equal(0)

    await service.commitSale({ saleId: 'sale-delivered', operationId: 'commit-delivered', businessDate: DATE, auth: ACTOR, lines: [{ lineId: 'line-delivered', productId: PRODUCT_ID, quantity: 2 }] })
    await service.deliverSale({ saleId: 'sale-delivered', deliveredAt: '2026-10-15T13:00:00.000Z', operationId: 'delivery-delivered', deliveredBy: 'actor-1' })
    const repeatedDelivery = await service.deliverSale({ saleId: 'sale-delivered', deliveredAt: '2026-10-15T13:00:00.000Z', operationId: 'delivery-other', deliveredBy: 'actor-1' })
    expect(repeatedDelivery.appliedMovementCount).to.equal(0)
  })

  it('requires an authenticated delivery actor', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    await expectRejected(async () => await service.deliverSale({ saleId: 'sale-actor', deliveredAt: '2026-10-15T13:00:00.000Z', operationId: 'delivery-actor', deliveredBy: '' }), STOCK_ERROR_CODES.STOCK_FORBIDDEN)
    expect(repository.transactionCalls).to.equal(0)
  })

  it('restores a full tracked delivery from its original allocations without changing other commitments', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    await service.commitSale({ saleId: 'sale-return-full', operationId: 'commit-return-full', businessDate: DATE, auth: ACTOR, lines: [{ lineId: 'line-return-full', productId: PRODUCT_ID, quantity: 7 }] })
    await service.commitSale({ saleId: 'sale-other', operationId: 'commit-other', businessDate: DATE, auth: ACTOR, lines: [{ lineId: 'line-other', productId: PRODUCT_ID, quantity: 1 }] })
    await service.deliverSale({ saleId: 'sale-return-full', deliveredAt: '2026-10-15T13:00:00.000Z', operationId: 'delivery-return-full', deliveredBy: ACTOR.actorId })

    const result = await service.returnSale({
      saleId: 'sale-return-full',
      operationId: 'return-full',
      businessDate: DATE,
      auth: ACTOR,
      lines: [{ productId: PRODUCT_ID, quantity: 7 }],
      occurredAt: new Date('2026-10-15T14:00:00.000Z')
    })

    expect(result).to.include({ movementCount: 2, appliedMovementCount: 2, alreadyAppliedCount: 0, projectionCount: 4 })
    expect(repository.products.get(PRODUCT_ID)).to.deep.include({ physicalQuantity: 10, committedQuantity: 1, availableQuantity: 9 })
    expect(repository.buckets.get('bucket-first')).to.deep.include({ receivedQuantity: 4, availableQuantity: 4, committedQuantity: 0 })
    expect(repository.buckets.get('bucket-later')).to.deep.include({ receivedQuantity: 6, availableQuantity: 5, committedQuantity: 1 })
    expect(repository.movements.filter(({ type }) => type === INVENTORY_MOVEMENT_TYPES.RETURN_IN)).to.have.length(2)
  })

  it('restores partial tracked returns in the original FEFO allocation order', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    await service.commitSale({ saleId: 'sale-return-partial', operationId: 'commit-return-partial', businessDate: DATE, auth: ACTOR, lines: [{ lineId: 'line-return-partial', productId: PRODUCT_ID, quantity: 7 }] })
    await service.deliverSale({ saleId: 'sale-return-partial', deliveredAt: '2026-10-15T13:00:00.000Z', operationId: 'delivery-return-partial', deliveredBy: ACTOR.actorId })

    await service.returnSale({ saleId: 'sale-return-partial', operationId: 'return-partial', businessDate: DATE, auth: ACTOR, lines: [{ productId: PRODUCT_ID, quantity: 5 }] })

    expect(repository.movements.filter(({ type }) => type === INVENTORY_MOVEMENT_TYPES.RETURN_IN).map(({ expiryBucketId, quantity }) => ({ expiryBucketId, quantity }))).to.deep.equal([
      { expiryBucketId: 'bucket-first', quantity: 4 },
      { expiryBucketId: 'bucket-later', quantity: 1 }
    ])
    expect(repository.products.get(PRODUCT_ID)).to.deep.include({ physicalQuantity: 8, committedQuantity: 0, availableQuantity: 8 })
  })

  it('restores non-tracked physical stock without creating a commitment or bucket', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    await service.commitSale({ saleId: 'sale-return-untracked', operationId: 'commit-return-untracked', businessDate: DATE, auth: ACTOR, lines: [{ lineId: 'line-return-untracked', productId: UNTRACKED_PRODUCT_ID, quantity: 3 }] })
    await service.deliverSale({ saleId: 'sale-return-untracked', deliveredAt: '2026-10-15T13:00:00.000Z', operationId: 'delivery-return-untracked', deliveredBy: ACTOR.actorId })

    const result = await service.returnSale({ saleId: 'sale-return-untracked', operationId: 'return-untracked', businessDate: DATE, auth: ACTOR, lines: [{ productId: UNTRACKED_PRODUCT_ID, quantity: 2 }] })

    expect(result).to.include({ movementCount: 1, projectionCount: 1 })
    expect(repository.products.get(UNTRACKED_PRODUCT_ID)).to.deep.include({ physicalQuantity: 9, committedQuantity: 0, availableQuantity: 9 })
    expect(repository.movements.filter(({ type }) => type === INVENTORY_MOVEMENT_TYPES.RETURN_IN)[0]).to.include({ expiryBucketId: undefined, quantity: 2 })
    expect([...repository.buckets.values()]).to.have.length(2)
  })

  it('rejects returns before delivery, for wrong ownership, and beyond delivered quantity without projection writes', async () => {
    const beforeDeliveryRepository = newRepository()
    const beforeDeliveryService = new StockService(beforeDeliveryRepository)
    await beforeDeliveryService.commitSale({ saleId: 'sale-not-delivered', operationId: 'commit-not-delivered', businessDate: DATE, auth: ACTOR, lines: [{ lineId: 'line-not-delivered', productId: PRODUCT_ID, quantity: 2 }] })
    await expectRejected(async () => await beforeDeliveryService.returnSale({ saleId: 'sale-not-delivered', operationId: 'return-not-delivered', businessDate: DATE, auth: ACTOR, lines: [{ productId: PRODUCT_ID, quantity: 1 }] }), STOCK_ERROR_CODES.STOCK_INSUFFICIENT)
    expect(beforeDeliveryRepository.projectionSessions).to.have.length(2)
    expect(beforeDeliveryRepository.movements.filter(({ type }) => type === INVENTORY_MOVEMENT_TYPES.RETURN_IN)).to.have.length(0)

    const repository = newRepository()
    const service = new StockService(repository)
    await service.commitSale({ saleId: 'sale-return-invalid', operationId: 'commit-return-invalid', businessDate: DATE, auth: ACTOR, lines: [{ lineId: 'line-return-invalid', productId: PRODUCT_ID, quantity: 3 }] })
    await service.deliverSale({ saleId: 'sale-return-invalid', deliveredAt: '2026-10-15T13:00:00.000Z', operationId: 'delivery-return-invalid', deliveredBy: ACTOR.actorId })
    const projectionCount = repository.projectionSessions.length

    await expectRejected(async () => await service.returnSale({ saleId: 'other-sale', operationId: 'return-wrong-sale', businessDate: DATE, auth: ACTOR, lines: [{ productId: PRODUCT_ID, quantity: 1 }] }))
    await expectRejected(async () => await service.returnSale({ saleId: 'sale-return-invalid', operationId: 'return-wrong-product', businessDate: DATE, auth: ACTOR, lines: [{ productId: UNTRACKED_PRODUCT_ID, quantity: 1 }] }))
    await expectRejected(async () => await service.returnSale({ saleId: 'sale-return-invalid', operationId: 'return-wrong-line', businessDate: DATE, auth: ACTOR, lines: [{ productId: PRODUCT_ID, lineId: 'other-line', quantity: 1 }] }))
    await expectRejected(async () => await service.returnSale({ saleId: 'sale-return-invalid', operationId: 'return-over', businessDate: DATE, auth: ACTOR, lines: [{ productId: PRODUCT_ID, quantity: 4 }] }))

    expect(repository.projectionSessions).to.have.length(projectionCount)
    expect(repository.movements.filter(({ type }) => type === INVENTORY_MOVEMENT_TYPES.RETURN_IN)).to.have.length(0)
  })

  it('reports matching return retries as already applied and rejects conflicting idempotency', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    await service.commitSale({ saleId: 'sale-return-retry', operationId: 'commit-return-retry', businessDate: DATE, auth: ACTOR, lines: [{ lineId: 'line-return-retry', productId: PRODUCT_ID, quantity: 3 }] })
    await service.deliverSale({ saleId: 'sale-return-retry', deliveredAt: '2026-10-15T13:00:00.000Z', operationId: 'delivery-return-retry', deliveredBy: ACTOR.actorId })

    const input = { saleId: 'sale-return-retry', operationId: 'return-retry', businessDate: DATE, auth: ACTOR, lines: [{ productId: PRODUCT_ID, quantity: 3 }] }
    const first = await service.returnSale(input)
    const physicalAfterFirst = repository.products.get(PRODUCT_ID)?.physicalQuantity
    const projectionCount = repository.projectionSessions.length
    const second = await service.returnSale(input)

    expect(first).to.include({ appliedMovementCount: 1, alreadyAppliedCount: 0 })
    expect(second).to.include({ movementCount: 0, appliedMovementCount: 0, alreadyAppliedCount: 1, projectionCount: 0 })
    expect(repository.products.get(PRODUCT_ID)?.physicalQuantity).to.equal(physicalAfterFirst)
    expect(repository.projectionSessions).to.have.length(projectionCount)
    await expectRejected(async () => await service.returnSale({ ...input, lines: [{ productId: PRODUCT_ID, quantity: 2 }] }), STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT)
  })

  it('rejects malformed return identity and lines before opening a transaction', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    await expectRejected(async () => await service.returnSale({ saleId: 'sale-invalid', operationId: 'return-invalid', businessDate: DATE, auth: { actorId: '', canManageStock: false }, lines: [{ productId: PRODUCT_ID, quantity: 1 }] }), STOCK_ERROR_CODES.STOCK_FORBIDDEN)
    await expectRejected(async () => await service.returnSale({ saleId: 'sale-invalid', operationId: 'return-invalid', businessDate: DATE, auth: ACTOR, lines: [{ productId: PRODUCT_ID, quantity: 0 }] }), STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE)
    expect(repository.transactionCalls).to.equal(0)
  })
})
