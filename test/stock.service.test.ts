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
  type StockTransactionContext,
  type PurchaseAdjustmentInput,
  type ExpiredRemovalInput,
  type StockOverviewResult,
  type StockProductDetailResult,
  type StockRotationInput
} from '../src/interfaces/stock.interface'
import { StockService, StockServiceError } from '../src/services/stock'

const PRODUCT_ID = 'product-1'
const UNTRACKED_PRODUCT_ID = 'product-2'
const ACTOR: StockServiceAuth = { actorId: 'actor-1', canManageStock: false }
const DATE = '2026-10-15'

interface TestProductRecord {
  productId: string
  minimum: number | null
  snapshot: StockProductSnapshot
}

interface TestMinimumAuditRecord {
  productId: string
  actorId: string
  previousMinimum: number | null
  newMinimum: number
  occurredAt: Date
  correlationId?: string
  reason?: string
}

class MemoryRepository implements StockRepository {
  products = new Map<string, StockProductSnapshot>()
  buckets = new Map<string, StockBucketSnapshot>()
  movements: StockMovementRecord[] = []
  minimums = new Map<string, number>()
  minimumAudits: TestMinimumAuditRecord[] = []
  transactionCalls = 0
  minimumUpdateSessions: Array<StockRepositorySession | undefined> = []
  minimumReadSessions: Array<StockRepositorySession | undefined> = []
  minimumAuditSessions: Array<StockRepositorySession | undefined> = []
  rotationHistories = new Map<string, StockRotationInput>()
  failMinimumAudit = false
  projectionSessions: Array<{ method: string, session: StockRepositorySession | undefined }> = []
  receiptSessions: StockRepositorySession[] = []
  private movementSequence = 0

  async withTransaction<T> (work: (context: StockTransactionContext) => Promise<T>): Promise<T> {
    this.transactionCalls += 1
    const session: StockRepositorySession = { transactionId: `tx-${this.transactionCalls}` }
    const minimumsBefore = new Map(this.minimums)
    const productsBefore = new Map(this.products)
    const auditsBefore = [...this.minimumAudits]
    try {
      return await work(Object.assign(this, { session }))
    } catch (error) {
      this.minimums = minimumsBefore
      this.products = productsBefore
      this.minimumAudits = auditsBefore
      throw error
    }
  }

  async getProduct (productId: string): Promise<StockProductSnapshot | undefined> {
    return this.products.get(productId)
  }

  async getProductMinimum (productId: string, session?: StockRepositorySession): Promise<{ productId: string, minimum: number | null } | undefined> {
    this.minimumReadSessions.push(session)
    if (!this.products.has(productId)) return undefined
    return { productId, minimum: this.minimums.get(productId) ?? null }
  }

  async getBuckets (productId: string): Promise<StockBucketSnapshot[]> {
    return [...this.buckets.values()].filter((bucket) => bucket.productId === productId)
  }

  async getBucket (bucketId: string): Promise<StockBucketSnapshot | undefined> {
    return this.buckets.get(bucketId)
  }

  async findMovementByIdempotencyKey (idempotencyKey: string): Promise<StockMovementRecord | undefined> {
    return this.movements.find((movement) => movement.idempotencyKey === idempotencyKey)
  }

  async findMovements (query: { productId?: string, sourceType?: string, sourceId?: string, type?: InventoryMovementType, limit?: number }): Promise<StockMovementRecord[]> {
    const movements = this.movements.filter((movement) =>
      (query.productId === undefined || movement.productId === query.productId) &&
      (query.sourceType === undefined || movement.sourceType === query.sourceType) &&
      (query.sourceId === undefined || movement.sourceId === query.sourceId) &&
      (query.type === undefined || movement.type === query.type))
    const ordered = [...movements].sort((left, right) => {
      const occurredAtComparison = right.occurredAt.getTime() - left.occurredAt.getTime()
      return occurredAtComparison !== 0 ? occurredAtComparison : (right.movementId ?? '').localeCompare(left.movementId ?? '')
    })
    return query.limit === undefined ? ordered : ordered.slice(0, query.limit)
  }

  async listProducts (page: number, pageSize: number): Promise<{ total: number, items: TestProductRecord[] }> {
    const items = [...this.products.values()].map((snapshot) => ({
      productId: snapshot.productId,
      minimum: this.minimums.get(snapshot.productId) ?? null,
      snapshot
    }))
    return { total: items.length, items: items.slice((page - 1) * pageSize, page * pageSize) }
  }

  async getSalesHistory (productIds: string[], businessDate: string, rotationDays: number, timeZone: string): Promise<StockRotationInput[]> {
    return productIds.map((productId) => this.rotationHistories.get(productId) ?? {
      productId,
      productCreatedAt: '2020-01-01T03:00:00.000Z',
      businessDate,
      timeZone,
      rotationDays,
      sales: [{ occurredAt: `${businessDate}T00:00:00.000Z`, quantity: 1 }]
    })
  }

  async updateProductMinimum (productId: string, minimum: number, session?: StockRepositorySession): Promise<{ productId: string, minimum: number } | undefined> {
    this.minimumUpdateSessions.push(session)
    if (!this.products.has(productId)) return undefined
    this.minimums.set(productId, minimum)
    return { productId, minimum }
  }

  async insertMinimumAudit (audit: TestMinimumAuditRecord, session?: StockRepositorySession): Promise<TestMinimumAuditRecord> {
    this.minimumAuditSessions.push(session)
    if (this.failMinimumAudit) throw new Error('audit persistence failed')
    this.minimumAudits.push(audit)
    return audit
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
  repository.minimums.set(PRODUCT_ID, 2)
  repository.minimums.set(UNTRACKED_PRODUCT_ID, 1)
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
  it('S-05/TC-015: builds a page-scoped overview through pure availability, expiry, and low-stock rules', async () => {
    const repository = newRepository()
    repository.buckets.clear()
    repository.buckets.set('bucket-expired', bucket('bucket-expired', '2026-10-10', 2))
    repository.buckets.set('bucket-near', bucket('bucket-near', '2026-10-20', 2))
    repository.buckets.set('bucket-later', bucket('bucket-later', '2026-12-20', 6))
    repository.minimums.set(PRODUCT_ID, 8)
    const service = new StockService(repository)

    const overview: StockOverviewResult = await service.getOverview({
      businessDate: DATE,
      page: 1,
      pageSize: 2,
      auth: ACTOR
    })

    expect(overview.total).to.equal(2)
    expect(overview.summary).to.deep.equal({
      productCount: 2,
      physicalQuantity: 20,
      committedQuantity: 0,
      availableToSell: 18,
      alertCount: 3
    })
    expect(overview.items[0]).to.include({ productId: PRODUCT_ID, dataQuality: STOCK_DATA_QUALITY.COMPLETE, minimum: 8 })
    expect(overview.items[0].alerts.map(({ type }) => type)).to.deep.equal(['LOW_STOCK', 'EXPIRED', 'EXPIRING_SOON'])
    expect(overview.items[1]).to.include({ productId: UNTRACKED_PRODUCT_ID, dataQuality: STOCK_DATA_QUALITY.COMPLETE, expiredQuantity: 0 })
  })

  it('adds persistence-backed low rotation while preserving existing overview alerts', async () => {
    const repository = newRepository()
    repository.minimums.set(PRODUCT_ID, 10)
    repository.rotationHistories.set(PRODUCT_ID, {
      productId: PRODUCT_ID,
      productCreatedAt: '2026-07-17T03:00:00.000Z',
      businessDate: DATE,
      timeZone: 'America/Argentina/Buenos_Aires',
      rotationDays: 90,
      sales: []
    })
    const service = new StockService(repository)

    const overview = await service.getOverview({ businessDate: DATE, page: 1, pageSize: 1, auth: ACTOR })

    expect(overview.items[0].alerts.map(({ type }) => type)).to.include.members(['LOW_STOCK', 'LOW_ROTATION'])
    expect(overview.items[0].alerts.find(({ type }) => type === 'LOW_ROTATION')).to.deep.include({
      productId: PRODUCT_ID,
      dataQuality: STOCK_DATA_QUALITY.COMPLETE
    })
  })

  it('keeps insufficient history separate from genuine zero-sales low rotation in overview and detail', async () => {
    const repository = newRepository()
    repository.rotationHistories.set(PRODUCT_ID, {
      productId: PRODUCT_ID,
      productCreatedAt: '2026-10-01T03:00:00.000Z',
      businessDate: DATE,
      timeZone: 'America/Argentina/Buenos_Aires',
      rotationDays: 90,
      sales: []
    })
    repository.rotationHistories.set(UNTRACKED_PRODUCT_ID, {
      productId: UNTRACKED_PRODUCT_ID,
      productCreatedAt: '2026-07-17T03:00:00.000Z',
      businessDate: DATE,
      timeZone: 'America/Argentina/Buenos_Aires',
      rotationDays: 90,
      sales: []
    })
    const service = new StockService(repository)

    const overview = await service.getOverview({ businessDate: DATE, page: 1, pageSize: 2, auth: ACTOR })
    const detail = await service.getProductDetail({ productId: PRODUCT_ID, businessDate: DATE, movementLimit: 5, auth: ACTOR })

    expect(overview.items[0].alerts.find(({ type }) => type === 'LOW_ROTATION')).to.deep.include({ dataQuality: STOCK_DATA_QUALITY.INSUFFICIENT_HISTORY })
    expect(detail.alerts.find(({ type }) => type === 'LOW_ROTATION')).to.deep.include({ dataQuality: STOCK_DATA_QUALITY.INSUFFICIENT_HISTORY })
    expect(overview.items[1].alerts.find(({ type }) => type === 'LOW_ROTATION')).to.deep.include({ dataQuality: STOCK_DATA_QUALITY.COMPLETE })
  })

  it('S-22/TC-031: keeps overview totals page-scoped and fails closed for unreconciled projections', async () => {
    const repository = newRepository()
    repository.products.set('unreconciled', { ...untrackedProduct(), productId: 'unreconciled', baselineStatus: BASELINE_STATUS.UNVERIFIED })
    repository.minimums.set('unreconciled', 0)
    const service = new StockService(repository)

    const overview = await service.getOverview({ businessDate: DATE, page: 1, pageSize: 1, auth: ACTOR })

    expect(overview.total).to.equal(3)
    expect(overview.summary.productCount).to.equal(1)
    expect(overview.summary.physicalQuantity).to.equal(10)
    expect(overview.items[0].dataQuality).to.equal(STOCK_DATA_QUALITY.COMPLETE)

    const secondPage = await service.getOverview({ businessDate: DATE, page: 3, pageSize: 1, auth: ACTOR })
    const unreconciled = secondPage.items[0]
    expect(unreconciled.dataQuality).to.equal(STOCK_DATA_QUALITY.INCOMPLETE)
    expect(unreconciled.availableToSell).to.equal(0)
    expect(unreconciled.alerts.find(({ type }) => type === 'LOW_STOCK')).to.deep.include({ dataQuality: STOCK_DATA_QUALITY.INCOMPLETE })
  })

  it('S-05: returns deterministic detail buckets and movement limits without changing product projections', async () => {
    const repository = newRepository()
    repository.movements.push(
      { productId: PRODUCT_ID, type: INVENTORY_MOVEMENT_TYPES.SALE_COMMIT, quantity: 1, occurredAt: new Date('2026-10-15T10:00:00.000Z'), sourceType: 'SALE', sourceId: 'sale-1', sourceEvent: 'SALE_COMMIT', operationId: 'op-1', idempotencyKey: 'key-1', rulesVersion: 'v1', createdBy: 'actor-1', movementId: 'movement-b' },
      { productId: PRODUCT_ID, type: INVENTORY_MOVEMENT_TYPES.PURCHASE_IN, quantity: 2, occurredAt: new Date('2026-10-15T12:00:00.000Z'), sourceType: 'PURCHASE', sourceId: 'buy-1', sourceEvent: 'PURCHASE_RECEIPT', operationId: 'op-2', idempotencyKey: 'key-2', rulesVersion: 'v1', createdBy: 'actor-1', movementId: 'movement-a' }
    )
    const before = repository.products.get(PRODUCT_ID)
    const service = new StockService(repository)

    const detail: StockProductDetailResult = await service.getProductDetail({ productId: PRODUCT_ID, businessDate: DATE, movementLimit: 1, auth: ACTOR })

    expect(detail.buckets.map(({ bucketId }) => bucketId)).to.deep.equal(['bucket-first', 'bucket-later'])
    expect(detail.movements).to.have.length(1)
    expect(detail.movements[0].movementId).to.equal('movement-a')
    expect(detail.availability.availableToSell).to.equal(10)
    expect(repository.products.get(PRODUCT_ID)).to.deep.equal(before)
  })

  it('TC-016: validates minimum updates, propagates actor context, and never mutates Product.stock projections', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    const before = repository.products.get(PRODUCT_ID)

    const result = await service.updateMinimum(PRODUCT_ID, 7, ACTOR)
    expect(result).to.deep.equal({ productId: PRODUCT_ID, minimum: 7 })
    expect(repository.minimums.get(PRODUCT_ID)).to.equal(7)
    expect(repository.products.get(PRODUCT_ID)).to.deep.equal(before)
    await expectRejected(async () => await service.updateMinimum(PRODUCT_ID, -1, ACTOR), STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE)
    await expectRejected(async () => await service.updateMinimum(PRODUCT_ID, 1.5, ACTOR), STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE)
    await expectRejected(async () => await service.updateMinimum(PRODUCT_ID, 1, { ...ACTOR, actorId: '' }), STOCK_ERROR_CODES.STOCK_FORBIDDEN)
    await expectRejected(async () => await service.updateMinimum('missing', 1, ACTOR), STOCK_ERROR_CODES.STOCK_PRODUCT_NOT_FOUND)
  })

  it('records an append-only minimum audit in the same transaction with actor, correlation, and reason', async () => {
    const repository = newRepository()
    const service = new StockService(repository)

    const result = await service.updateMinimum(PRODUCT_ID, 7, ACTOR, {
      correlationId: 'correlation-1',
      reason: 'Replenishment policy changed'
    })

    expect(result).to.deep.equal({ productId: PRODUCT_ID, minimum: 7 })
    expect(repository.minimumAudits).to.have.length(1)
    expect(repository.minimumAudits[0]).to.include({
      productId: PRODUCT_ID,
      actorId: ACTOR.actorId,
      previousMinimum: 2,
      newMinimum: 7,
      correlationId: 'correlation-1',
      reason: 'Replenishment policy changed'
    })
    expect(repository.minimumAudits[0].occurredAt).to.be.instanceOf(Date)
    expect(repository.minimumReadSessions[0]?.transactionId).to.equal('tx-1')
    expect(repository.minimumUpdateSessions[0]?.transactionId).to.equal('tx-1')
    expect(repository.minimumAuditSessions[0]?.transactionId).to.equal('tx-1')
  })

  it('does not create a minimum audit for an unchanged value', async () => {
    const repository = newRepository()
    const service = new StockService(repository)

    const result = await service.updateMinimum(PRODUCT_ID, 2, ACTOR, { reason: 'No change' })

    expect(result).to.deep.equal({ productId: PRODUCT_ID, minimum: 2 })
    expect(repository.minimumAudits).to.have.length(0)
  })

  it('fails closed and rolls back the minimum when audit persistence fails', async () => {
    const repository = newRepository()
    repository.failMinimumAudit = true
    const service = new StockService(repository)

    await expectRejected(async () => await service.updateMinimum(PRODUCT_ID, 7, ACTOR, { correlationId: 'correlation-2' }), STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR)

    expect(repository.minimums.get(PRODUCT_ID)).to.equal(2)
    expect(repository.minimumAudits).to.have.length(0)
  })

  it('S-01/S-22/TC-031: reads availability without writing and reports incomplete snapshots', async () => {
    const repository = newRepository()
    const service = new StockService(repository)

    const result = await service.getAvailability({ productIds: [PRODUCT_ID, 'missing'], businessDate: DATE, auth: ACTOR })

    expect(result[0]).to.deep.include({ productId: PRODUCT_ID, availableToSell: 10, dataQuality: STOCK_DATA_QUALITY.COMPLETE })
    expect(result[1]).to.deep.include({ productId: 'missing', dataQuality: STOCK_DATA_QUALITY.INCOMPLETE })
    expect(repository.movements).to.have.length(0)
  })

  it('S-21: aggregates duplicate lines and fails closed for insufficient or unavailable stock', async () => {
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

  it('S-02/TC-010/TC-018: commits tracked lines with FEFO allocations and leaves physical stock unchanged', async () => {
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

  it('S-04: filters expired buckets from FEFO while retaining them in projections', async () => {
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

  it('S-02/TC-018: commits non-tracked lines without inventing buckets and preserves idempotency', async () => {
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

  it('S-02/TC-018: rejects conflicting idempotency and cancels commitments with compensations', async () => {
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

  it('S-02/TC-018: does not treat a new operation as an already-applied commitment', async () => {
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

  it('S-02/TC-018: does not treat a new adjustment operation as already applied', async () => {
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

  it('TC-018: rejects retries with a different actor or rules version as semantic conflicts', async () => {
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

  it('S-02/TC-010: requires explicit adjustment additions or releases and supports both paths', async () => {
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

  it('S-02: rejects releasing a bucket committed by another sale', async () => {
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

  it('NFR-004: fails closed when the actor is missing', async () => {
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

  it('S-03/TC-010/TC-018: receives tracked purchase lines into buckets and physical stock without commitments', async () => {
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

  it('S-03: receives non-tracked purchase lines physically and rejects expiry dates', async () => {
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

  it('S-03/NFR-004: rejects invalid receipt identity, quantities, expiry, and unknown tracking before writing', async () => {
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

  it('S-03/TC-018: makes matching receipt retries no-ops and conflicting retries fail closed', async () => {
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

  it('S-07/TC-010/TC-018: delivers tracked commitments once while preserving available quantities', async () => {
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

  it('S-07: delivers non-tracked commitments by closing the ledger commitment and physical stock', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    await service.commitSale({ saleId: 'sale-untracked-delivery', operationId: 'commit-untracked-delivery', businessDate: DATE, auth: ACTOR, lines: [{ lineId: 'line-delivery', productId: UNTRACKED_PRODUCT_ID, quantity: 3 }] })
    const input: SaleDeliveryInput = { saleId: 'sale-untracked-delivery', deliveredAt: '2026-10-15T13:00:00.000Z', operationId: 'delivery-untracked', deliveredBy: 'actor-1' }

    await service.deliverSale(input)

    expect(repository.products.get(UNTRACKED_PRODUCT_ID)).to.deep.include({ physicalQuantity: 7, committedQuantity: 0, availableQuantity: 7 })
    expect(repository.movements).to.have.length(2)
    expect(repository.movements[1]).to.include({ type: INVENTORY_MOVEMENT_TYPES.SALE_DELIVERED_OUT, quantity: 3, reversesMovementId: repository.movements[0].movementId })
  })

  it('S-07/TC-018: does not consume cancelled or already delivered commitments', async () => {
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

  it('NFR-004: requires an authenticated delivery actor', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    await expectRejected(async () => await service.deliverSale({ saleId: 'sale-actor', deliveredAt: '2026-10-15T13:00:00.000Z', operationId: 'delivery-actor', deliveredBy: '' }), STOCK_ERROR_CODES.STOCK_FORBIDDEN)
    expect(repository.transactionCalls).to.equal(0)
  })

  it('S-06/TC-010: restores a full tracked delivery from its original allocations without changing other commitments', async () => {
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

  it('S-06: restores partial tracked returns in the original FEFO allocation order', async () => {
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

  it('S-06: restores non-tracked physical stock without creating a commitment or bucket', async () => {
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

  it('S-06: rejects returns before delivery, for wrong ownership, and beyond delivered quantity without projection writes', async () => {
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

  it('S-06/TC-018: reports matching return retries as already applied and rejects conflicting idempotency', async () => {
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

  it('S-06/NFR-004: rejects malformed return identity and lines before opening a transaction', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    await expectRejected(async () => await service.returnSale({ saleId: 'sale-invalid', operationId: 'return-invalid', businessDate: DATE, auth: { actorId: '', canManageStock: false }, lines: [{ productId: PRODUCT_ID, quantity: 1 }] }), STOCK_ERROR_CODES.STOCK_FORBIDDEN)
    await expectRejected(async () => await service.returnSale({ saleId: 'sale-invalid', operationId: 'return-invalid', businessDate: DATE, auth: ACTOR, lines: [{ productId: PRODUCT_ID, quantity: 0 }] }), STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE)
    expect(repository.transactionCalls).to.equal(0)
  })

  it('TC-010: adjusts non-tracked purchase stock in both directions without changing commitments', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    const positive: PurchaseAdjustmentInput = {
      buyId: 'buy-adjust-untracked',
      operationId: 'adjust-untracked-add',
      businessDate: DATE,
      auth: ACTOR,
      reason: 'Corrected receiving count',
      lines: [{ lineId: 'adjust-line-add', productId: UNTRACKED_PRODUCT_ID, quantity: 3 }]
    }

    const added = await service.adjustPurchase(positive)
    const removed = await service.adjustPurchase({
      ...positive,
      operationId: 'adjust-untracked-remove',
      reason: 'Removed damaged units',
      lines: [{ lineId: 'adjust-line-remove', productId: UNTRACKED_PRODUCT_ID, quantity: -2 }]
    })

    expect(added).to.include({ appliedMovementCount: 1, projectionCount: 1 })
    expect(removed).to.include({ appliedMovementCount: 1, projectionCount: 1 })
    expect(repository.products.get(UNTRACKED_PRODUCT_ID)).to.deep.include({ physicalQuantity: 11, availableQuantity: 11, committedQuantity: 0 })
    expect(repository.movements.filter(({ type }) => type === INVENTORY_MOVEMENT_TYPES.PROJECTION_REPAIR).map(({ quantity, reason, sourceEvent }) => ({ quantity, reason, sourceEvent }))).to.deep.equal([
      { quantity: 3, reason: 'Corrected receiving count', sourceEvent: 'PURCHASE_ADJUSTMENT' },
      { quantity: 2, reason: 'Removed damaged units', sourceEvent: 'PURCHASE_ADJUSTMENT' }
    ])
  })

  it('adjusts an existing tracked bucket while preserving its commitments', async () => {
    const repository = newRepository()
    repository.products.set(PRODUCT_ID, { ...trackedProduct(), physicalQuantity: 12, availableQuantity: 10, committedQuantity: 2 })
    repository.buckets.set('bucket-first', bucket('bucket-first', '2026-10-20', 4, 2))
    const service = new StockService(repository)

    const result = await service.adjustPurchase({
      buyId: 'buy-adjust-tracked',
      operationId: 'adjust-tracked',
      businessDate: DATE,
      auth: ACTOR,
      reason: 'Supplier reconciliation',
      lines: [{ lineId: 'adjust-tracked-line', productId: PRODUCT_ID, expiryDate: '2026-10-20', quantity: 3 }]
    })

    expect(result).to.include({ appliedMovementCount: 1, projectionCount: 2 })
    expect(repository.products.get(PRODUCT_ID)).to.deep.include({ physicalQuantity: 15, availableQuantity: 13, committedQuantity: 2 })
    expect(repository.buckets.get('bucket-first')).to.deep.include({ receivedQuantity: 9, availableQuantity: 7, committedQuantity: 2 })
  })

  it('validates non-tracked purchase adjustments using the final cumulative quantity', async () => {
    const repository = newRepository()
    const service = new StockService(repository)

    const result = await service.adjustPurchase({
      buyId: 'buy-adjust-compensating-untracked',
      operationId: 'adjust-compensating-untracked',
      businessDate: DATE,
      auth: ACTOR,
      reason: 'Compensating correction',
      lines: [
        { lineId: 'adjust-add-large', productId: UNTRACKED_PRODUCT_ID, quantity: 100 },
        { lineId: 'adjust-remove-large', productId: UNTRACKED_PRODUCT_ID, quantity: -105 }
      ]
    })

    expect(result).to.include({ appliedMovementCount: 2, projectionCount: 2 })
    expect(repository.products.get(UNTRACKED_PRODUCT_ID)).to.deep.include({ physicalQuantity: 5, availableQuantity: 5, committedQuantity: 0 })
    expect(repository.movements).to.have.length(2)
  })

  it('validates tracked purchase adjustments using final cumulative bucket quantities', async () => {
    const repository = newRepository()
    const service = new StockService(repository)

    const result = await service.adjustPurchase({
      buyId: 'buy-adjust-compensating-tracked',
      operationId: 'adjust-compensating-tracked',
      businessDate: DATE,
      auth: ACTOR,
      reason: 'Compensating bucket correction',
      lines: [
        { lineId: 'adjust-add-tracked-large', productId: PRODUCT_ID, expiryDate: '2026-10-20', quantity: 100 },
        { lineId: 'adjust-remove-tracked-large', productId: PRODUCT_ID, expiryDate: '2026-10-20', quantity: -103 }
      ]
    })

    expect(result).to.include({ appliedMovementCount: 2, projectionCount: 4 })
    expect(repository.products.get(PRODUCT_ID)).to.deep.include({ physicalQuantity: 7, availableQuantity: 7, committedQuantity: 0 })
    expect(repository.buckets.get('bucket-first')).to.deep.include({ receivedQuantity: 1, availableQuantity: 1, committedQuantity: 0 })
    expect(repository.movements).to.have.length(2)
  })

  it('rejects a non-tracked batch whose final cumulative quantity is negative without writes', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    const initialProduct = repository.products.get(UNTRACKED_PRODUCT_ID)

    await expectRejected(async () => await service.adjustPurchase({
      buyId: 'buy-adjust-invalid-cumulative-untracked',
      operationId: 'adjust-invalid-cumulative-untracked',
      businessDate: DATE,
      auth: ACTOR,
      reason: 'Invalid cumulative correction',
      lines: [
        { lineId: 'adjust-add-invalid-large', productId: UNTRACKED_PRODUCT_ID, quantity: 100 },
        { lineId: 'adjust-remove-invalid-large', productId: UNTRACKED_PRODUCT_ID, quantity: -111 }
      ]
    }), STOCK_ERROR_CODES.STOCK_INSUFFICIENT)

    expect(repository.products.get(UNTRACKED_PRODUCT_ID)).to.deep.equal(initialProduct)
    expect(repository.movements).to.have.length(0)
    expect(repository.projectionSessions).to.have.length(0)
  })

  it('rejects a tracked batch whose final cumulative bucket quantity is negative without writes', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    const initialProduct = repository.products.get(PRODUCT_ID)
    const initialBucket = repository.buckets.get('bucket-first')

    await expectRejected(async () => await service.adjustPurchase({
      buyId: 'buy-adjust-invalid-cumulative-tracked',
      operationId: 'adjust-invalid-cumulative-tracked',
      businessDate: DATE,
      auth: ACTOR,
      reason: 'Invalid cumulative bucket correction',
      lines: [
        { lineId: 'adjust-add-invalid-tracked-large', productId: PRODUCT_ID, expiryDate: '2026-10-20', quantity: 100 },
        { lineId: 'adjust-remove-invalid-tracked-large', productId: PRODUCT_ID, expiryDate: '2026-10-20', quantity: -105 }
      ]
    }), STOCK_ERROR_CODES.STOCK_INSUFFICIENT)

    expect(repository.products.get(PRODUCT_ID)).to.deep.equal(initialProduct)
    expect(repository.buckets.get('bucket-first')).to.deep.equal(initialBucket)
    expect(repository.movements).to.have.length(0)
    expect(repository.projectionSessions).to.have.length(0)
  })

  it('NFR-004: validates every purchase adjustment line before writing', async () => {
    const repository = newRepository()
    repository.products.set('unknown-tracking', { ...trackedProduct(), productId: 'unknown-tracking', expiryTracking: EXPIRY_TRACKING.UNKNOWN })
    const service = new StockService(repository)
    const base: PurchaseAdjustmentInput = {
      buyId: 'buy-adjust-invalid',
      operationId: 'adjust-invalid',
      businessDate: DATE,
      auth: ACTOR,
      reason: 'Correction',
      lines: [{ lineId: 'line-invalid', productId: UNTRACKED_PRODUCT_ID, quantity: 1 }]
    }

    for (const input of [
      { ...base, auth: { ...ACTOR, actorId: '' } },
      { ...base, reason: '   ' },
      { ...base, lines: [{ ...base.lines[0], quantity: 0 }] },
      { ...base, lines: [{ ...base.lines[0], quantity: 1.5 }] },
      { ...base, lines: [{ ...base.lines[0], expiryDate: '2026-11-01' }] },
      { ...base, lines: [{ ...base.lines[0], productId: PRODUCT_ID, expiryDate: '2026-11-01' }] },
      { ...base, lines: [{ ...base.lines[0], productId: 'unknown-tracking' }] },
      { ...base, lines: [{ ...base.lines[0], productId: PRODUCT_ID, expiryDate: '2026-10-21' }] },
      { ...base, lines: [{ ...base.lines[0], productId: UNTRACKED_PRODUCT_ID, quantity: -11 }] }
    ]) {
      await expectRejected(async () => await service.adjustPurchase(input))
    }

    expect(repository.movements).to.have.length(0)
    expect(repository.projectionSessions).to.have.length(0)
  })

  it('TC-018: rejects insufficient negative purchase adjustments and protects matching retries from conflicts', async () => {
    const repository = newRepository()
    const service = new StockService(repository)
    const input: PurchaseAdjustmentInput = {
      buyId: 'buy-adjust-retry',
      operationId: 'adjust-retry',
      businessDate: DATE,
      auth: ACTOR,
      reason: 'Count correction',
      lines: [{ lineId: 'adjust-retry-line', productId: UNTRACKED_PRODUCT_ID, quantity: 2 }]
    }

    const first = await service.adjustPurchase(input)
    const retry = await service.adjustPurchase(input)
    expect(first).to.include({ appliedMovementCount: 1, alreadyAppliedCount: 0 })
    expect(retry).to.include({ appliedMovementCount: 0, alreadyAppliedCount: 1, projectionCount: 0 })
    await expectRejected(async () => await service.adjustPurchase({ ...input, reason: 'Different correction' }), STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT)
    await expectRejected(async () => await service.adjustPurchase({ ...input, operationId: 'adjust-too-much', lines: [{ ...input.lines[0], quantity: -20 }] }), STOCK_ERROR_CODES.STOCK_INSUFFICIENT)
    expect(repository.products.get(UNTRACKED_PRODUCT_ID)?.physicalQuantity).to.equal(12)
    expect(repository.movements).to.have.length(1)
  })

  it('S-13/TC-010/TC-018: removes a complete expired bucket physically and is idempotent and conflict-safe', async () => {
    const repository = newRepository()
    repository.buckets.clear()
    repository.buckets.set('bucket-expired-remove', bucket('bucket-expired-remove', '2026-10-10', 8))
    const service = new StockService(repository)
    const input: ExpiredRemovalInput = {
      bucketId: 'bucket-expired-remove',
      operationId: 'expired-removal-1',
      businessDate: DATE,
      auth: ACTOR,
      reason: 'Destroyed expired goods'
    }

    const first = await service.removeExpiredBucket(input)
    const second = await service.removeExpiredBucket(input)

    expect(first).to.include({ appliedMovementCount: 1, projectionCount: 2 })
    expect(second).to.include({ appliedMovementCount: 0, alreadyAppliedCount: 1, projectionCount: 0 })
    expect(repository.products.get(PRODUCT_ID)).to.deep.include({ physicalQuantity: 2, availableQuantity: 2, committedQuantity: 0 })
    expect(repository.buckets.get('bucket-expired-remove')).to.deep.include({ receivedQuantity: 0, availableQuantity: 0, committedQuantity: 0 })
    expect(repository.movements[0]).to.include({ type: INVENTORY_MOVEMENT_TYPES.EXPIRED_REMOVAL, sourceType: 'EXPIRY_BUCKET', sourceId: 'bucket-expired-remove', expiryBucketId: 'bucket-expired-remove', quantity: 8, reason: 'Destroyed expired goods' })
    await expectRejected(async () => await service.removeExpiredBucket({ ...input, reason: 'Another reason' }), STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT)
  })

  it('S-13: blocks future, non-expired, committed, and malformed expired buckets before writes', async () => {
    const futureRepository = newRepository()
    futureRepository.buckets.set('bucket-future', bucket('bucket-future', '2026-12-20', 1))
    const futureService = new StockService(futureRepository)
    await expectRejected(async () => await futureService.removeExpiredBucket({ bucketId: 'bucket-future', operationId: 'remove-future', businessDate: DATE, auth: ACTOR, reason: 'Too early' }))
    expect(futureRepository.movements).to.have.length(0)

    const committedRepository = newRepository()
    committedRepository.buckets.set('bucket-committed', bucket('bucket-committed', '2026-10-10', 2, 1))
    const committedService = new StockService(committedRepository)
    await expectRejected(async () => await committedService.removeExpiredBucket({ bucketId: 'bucket-committed', operationId: 'remove-committed', businessDate: DATE, auth: ACTOR, reason: 'Blocked' }), STOCK_ERROR_CODES.EXPIRED_BUCKET_HAS_COMMITMENTS)
    expect(committedRepository.movements).to.have.length(0)

    const malformedRepository = newRepository()
    const malformedService = new StockService(malformedRepository)
    await expectRejected(async () => await malformedService.removeExpiredBucket({ bucketId: 'missing', operationId: 'remove-missing', businessDate: DATE, auth: ACTOR, reason: 'Missing' }))
    await expectRejected(async () => await malformedService.removeExpiredBucket({ bucketId: 'bucket-first', operationId: 'remove-no-reason', businessDate: DATE, auth: ACTOR, reason: ' ' }))
    expect(malformedRepository.movements).to.have.length(0)
  })
})
