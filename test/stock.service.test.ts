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

  async applyBucketProjectionDelta (bucketId: string, delta: { availableQuantityDelta: number, committedQuantityDelta: number }): Promise<void> {
    const bucket = this.buckets.get(bucketId)
    if (bucket === undefined) throw new Error(`Missing bucket ${bucketId}`)
    this.buckets.set(bucketId, {
      ...bucket,
      availableQuantity: bucket.availableQuantity + delta.availableQuantityDelta,
      committedQuantity: bucket.committedQuantity + delta.committedQuantityDelta
    })
  }

  async applyProductProjectionDelta (productId: string, delta: { availableQuantityDelta: number, committedQuantityDelta: number, physicalQuantityDelta: number }): Promise<void> {
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
})
