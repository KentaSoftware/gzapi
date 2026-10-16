import { expect } from 'chai'

import {
  BASELINE_STATUS,
  EXPIRY_TRACKING,
  STOCK_ERROR_CODES,
  STOCK_OPERATION_STATUSES,
  type BaselineStatus,
  type ExpiryTracking,
  type OpeningCountOperation,
  type StockErrorCode,
  type StockBucketSnapshot,
  type StockOpeningRepository,
  type StockProductSnapshot,
  type StockRepositorySession,
  type StockTransactionContext
} from '../src/interfaces/stock.interface'
import {
  confirmOpeningCount,
  OpeningCountError,
  previewOpeningCount
} from '../src/services/stockOpening'
import { createOpeningCountWriter } from '../src/services/stockOpeningWriter'
import { StockServiceError } from '../src/services/stock'

const ACTOR_ID = '507f1f77bcf86cd799439011'
const PRODUCT_ID = '507f1f77bcf86cd799439013'
const OTHER_PRODUCT_ID = '507f1f77bcf86cd799439014'

const input = {
  operationId: 'opening-2026-10-15',
  rows: [
    { productId: OTHER_PRODUCT_ID, countedQuantity: 2, expiryDate: '2026-12-31' },
    { productId: PRODUCT_ID, countedQuantity: 4 }
  ]
}

const auth = { actorId: ACTOR_ID, canManageStock: true, canApproveStockCount: true }

const OPENING_TEST_TRACKING = {
  TRACKED: 'TRACKED',
  NOT_TRACKED: 'NOT_TRACKED'
} as const

interface OpeningRepositoryEvents {
  sessions: string[]
  movementCount: number
  bucketReconciliationCount: number
  clearBucketCount: number
  productReconciliationCount: number
}

const recordSession = (events: OpeningRepositoryEvents | undefined, session: StockRepositorySession | undefined): void => {
  if (events !== undefined && session !== undefined) events.sessions.push(session.transactionId)
}

const product = (productId: string, expiryTracking: ExpiryTracking, stock = 0, baselineStatus: BaselineStatus = BASELINE_STATUS.UNVERIFIED): StockProductSnapshot => ({
  productId,
  physicalQuantity: stock,
  committedQuantity: 0,
  availableQuantity: stock,
  expiryTracking,
  baselineStatus
})

const openingRepository = (products: Record<string, ReturnType<typeof product>>, operations: OpeningCountOperation[] = [], buckets: Record<string, StockBucketSnapshot[]> = {}, events?: OpeningRepositoryEvents): StockOpeningRepository => {
  const storedOperations = [...operations]
  const methods: Omit<StockOpeningRepository, 'withTransaction'> = {
    getProduct: async (productId, session) => {
      recordSession(events, session)
      return products[productId]
    },
    getProductMinimum: async () => undefined,
    listProducts: async () => ({ total: 0, items: [] }),
    updateProductMinimum: async () => undefined,
    getBuckets: async (productId, session) => {
      recordSession(events, session)
      return buckets[productId] ?? []
    },
    getBucket: async () => undefined,
    findMovementByIdempotencyKey: async (_key, session) => {
      recordSession(events, session)
      return undefined
    },
    findMovements: async () => [],
    insertMovement: async (movement, session) => {
      recordSession(events, session)
      if (events !== undefined) events.movementCount += 1
      return movement
    },
    applyPhysicalBucketReceipt: async () => { throw new Error('not used') },
    applyBucketProjectionDelta: async () => undefined,
    applyProductProjectionDelta: async () => undefined,
    getOpeningOperation: async (operationId, session) => {
      recordSession(events, session)
      return storedOperations.find((operation) => operation.operationId === operationId)
    },
    insertOpeningOperation: async (operation, session) => {
      recordSession(events, session)
      storedOperations.push(operation)
      return operation
    },
    reconcileOpeningBuckets: async (_productId, _openingBuckets, session) => {
      recordSession(events, session)
      if (events !== undefined) events.bucketReconciliationCount += 1
    },
    clearOpeningBuckets: async (_productId, session) => {
      recordSession(events, session)
      if (events !== undefined) events.clearBucketCount += 1
    },
    reconcileOpeningProduct: async (_productId, _quantity, _actorId, _date, session) => {
      recordSession(events, session)
      if (events !== undefined) events.productReconciliationCount += 1
    }
  }
  const repository: StockOpeningRepository = {
    withTransaction: async <T>(work: (context: StockOpeningRepository & StockTransactionContext) => Promise<T>): Promise<T> => {
      const transaction: StockOpeningRepository & StockTransactionContext = {
        ...repository,
        session: { transactionId: 'opening-test-transaction' }
      }
      return await work(transaction)
    },
    ...methods
  }
  return repository
}

const writerErrorCode = async (writer: ReturnType<typeof createOpeningCountWriter>, plan: Parameters<ReturnType<typeof createOpeningCountWriter>>[0], context: Parameters<ReturnType<typeof createOpeningCountWriter>>[1]): Promise<StockErrorCode> => {
  try {
    await writer(plan, context)
    throw new Error('Expected opening writer to reject')
  } catch (error) {
    if (!(error instanceof StockServiceError)) throw error
    return error.code
  }
}

describe('Stock opening — preview and confirmation', () => {
  it('builds deterministic preview evidence without a writer or mutation', () => {
    const result = previewOpeningCount(input, auth)
    expect(result.plan.groups).to.deep.equal([
      { productId: PRODUCT_ID, expiryDate: null, countedQuantity: 4 },
      { productId: OTHER_PRODUCT_ID, expiryDate: '2026-12-31', countedQuantity: 2 }
    ])
    expect(result.evidence).to.deep.equal({
      status: STOCK_OPERATION_STATUSES.PENDING,
      operationId: input.operationId,
      actorId: ACTOR_ID,
      rulesVersion: 'stock-rules-v1',
      movementCount: 2,
      businessDataMutated: false
    })
  })

  it('rejects duplicate keys and invalid rows before confirmation', () => {
    expect(() => previewOpeningCount({
      ...input,
      rows: [input.rows[0], { ...input.rows[0], countedQuantity: 3 }]
    }, auth)).to.throw(OpeningCountError).and.have.property('code', STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE)
    expect(() => previewOpeningCount({
      ...input,
      rows: [{ productId: 'invalid', countedQuantity: 1 }]
    }, auth)).to.throw(OpeningCountError)
  })

  it('fails closed for unauthorized preview and confirmation', async () => {
    expect(() => previewOpeningCount(input, { ...auth, canManageStock: false })).to.throw(OpeningCountError).and.have.property('code', STOCK_ERROR_CODES.STOCK_FORBIDDEN)
    let writerCalls = 0
    const writer = async (): Promise<{ status: 'APPLIED', movementCount: number }> => {
      writerCalls += 1
      return { status: 'APPLIED', movementCount: 2 }
    }
    let rejection: unknown
    try {
      await confirmOpeningCount({ ...input, approvedBy: ACTOR_ID, approvalId: 'approval-1' }, { ...auth, canApproveStockCount: false }, writer)
    } catch (error) {
      rejection = error
    }
    expect(rejection).to.be.instanceOf(OpeningCountError)
    expect(writerCalls).to.equal(0)
  })

  it('rejects an approval actor mismatch before invoking the writer', async () => {
    let writerCalls = 0
    const writer = async (): Promise<{ status: 'APPLIED', movementCount: number }> => {
      writerCalls += 1
      return { status: 'APPLIED', movementCount: 2 }
    }

    let rejection: unknown
    try {
      await confirmOpeningCount({ ...input, approvedBy: '507f1f77bcf86cd799439015', approvalId: 'approval-mismatch' }, auth, writer)
    } catch (error) {
      rejection = error
    }

    expect(rejection).to.be.instanceOf(OpeningCountError).and.have.property('code', STOCK_ERROR_CODES.STOCK_FORBIDDEN)
    expect(writerCalls).to.equal(0)
  })

  it('calls the writer exactly once and reports applied or recoverable evidence', async () => {
    let writerCalls = 0
    const writer = async (): Promise<{ status: 'APPLIED', movementCount: number }> => {
      writerCalls += 1
      return { status: 'APPLIED', movementCount: 2 }
    }
    const applied = await confirmOpeningCount({ ...input, approvedBy: ACTOR_ID, approvalId: 'approval-1' }, auth, writer)
    expect(writerCalls).to.equal(1)
    expect(applied.evidence).to.deep.equal({
      status: STOCK_OPERATION_STATUSES.APPLIED,
      operationId: input.operationId,
      approvalId: 'approval-1',
      approvedBy: ACTOR_ID,
      actorId: ACTOR_ID,
      rulesVersion: 'stock-rules-v1',
      movementCount: 2,
      businessDataMutated: true
    })

    const failed = await confirmOpeningCount({ ...input, approvedBy: ACTOR_ID, approvalId: 'approval-2' }, auth, async () => ({ status: 'FAILED_RECOVERABLE' as const, movementCount: 0 }))
    expect(failed.evidence.status).to.equal(STOCK_OPERATION_STATUSES.FAILED_RECOVERABLE)
    expect(failed.evidence.businessDataMutated).to.equal(false)
  })

  it('keeps equivalent previews byte-for-byte deterministic', () => {
    const first = JSON.stringify(previewOpeningCount(input, auth))
    const second = JSON.stringify(previewOpeningCount({ ...input, rows: [...input.rows].reverse() }, auth))
    expect(first).to.equal(second)
  })

  it('writes tracked and non-tracked products through one repository transaction and retries zero-only operations', async () => {
    const trackedId = PRODUCT_ID
    const nonTrackedId = OTHER_PRODUCT_ID
    const repository = openingRepository({
      [trackedId]: product(trackedId, OPENING_TEST_TRACKING.TRACKED),
      [nonTrackedId]: product(nonTrackedId, OPENING_TEST_TRACKING.NOT_TRACKED)
    })
    const writer = createOpeningCountWriter(repository)
    const trackedPlan = previewOpeningCount({
      operationId: 'opening-write-1',
      rows: [{ productId: trackedId, countedQuantity: 4, expiryDate: '2026-12-31' }]
    }, auth).plan
    const first = await writer(trackedPlan, { actorId: ACTOR_ID, approvedBy: ACTOR_ID, approvalId: 'approval-1' })
    expect(first.status).to.equal(STOCK_OPERATION_STATUSES.APPLIED)
    expect(first.movementCount).to.equal(1)

    const zeroPlan = previewOpeningCount({
      operationId: 'opening-zero-1',
      rows: [{ productId: nonTrackedId, countedQuantity: 0 }]
    }, auth).plan
    const zeroFirst = await writer(zeroPlan, { actorId: ACTOR_ID, approvedBy: ACTOR_ID, approvalId: 'approval-zero' })
    const zeroRetry = await writer(zeroPlan, { actorId: ACTOR_ID, approvedBy: ACTOR_ID, approvalId: 'approval-zero' })
    expect(zeroFirst.movementCount).to.equal(0)
    expect(zeroRetry.status).to.equal(STOCK_OPERATION_STATUSES.IDEMPOTENT_RETRY)
    expect(zeroRetry.movementCount).to.equal(0)
  })

  it('fails closed for missing, unknown, reconciled, and committed opening state', async () => {
    const trackedPlan = previewOpeningCount({
      operationId: 'opening-validation-1',
      rows: [{ productId: PRODUCT_ID, countedQuantity: 1, expiryDate: '2026-12-31' }]
    }, auth).plan
    const context = { actorId: ACTOR_ID, approvedBy: ACTOR_ID, approvalId: 'approval-validation' }

    const missingWriter = createOpeningCountWriter(openingRepository({}))
    expect(await writerErrorCode(missingWriter, trackedPlan, context)).to.equal(STOCK_ERROR_CODES.STOCK_PRODUCT_NOT_FOUND)

    const unknownWriter = createOpeningCountWriter(openingRepository({
      [PRODUCT_ID]: product(PRODUCT_ID, EXPIRY_TRACKING.UNKNOWN)
    }))
    expect(await writerErrorCode(unknownWriter, trackedPlan, context)).to.equal(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE)

    const reconciledWriter = createOpeningCountWriter(openingRepository({
      [PRODUCT_ID]: product(PRODUCT_ID, EXPIRY_TRACKING.TRACKED, 1, BASELINE_STATUS.RECONCILED)
    }))
    expect(await writerErrorCode(reconciledWriter, trackedPlan, context)).to.equal(STOCK_ERROR_CODES.STOCK_BASELINE_ALREADY_RECONCILED)

    const committedWriter = createOpeningCountWriter(openingRepository({
      [PRODUCT_ID]: product(PRODUCT_ID, EXPIRY_TRACKING.TRACKED)
    }, [], {
      [PRODUCT_ID]: [{
        bucketId: '507f1f77bcf86cd799439015',
        productId: PRODUCT_ID,
        expiryDate: '2026-12-31',
        receivedQuantity: 2,
        availableQuantity: 1,
        committedQuantity: 1
      }]
    }))
    expect(await writerErrorCode(committedWriter, trackedPlan, context)).to.equal(STOCK_ERROR_CODES.STOCK_BUCKET_HAS_COMMITMENTS)
  })

  it('rejects semantic operation reuse and propagates one transaction session to every opening operation', async () => {
    const events: OpeningRepositoryEvents = {
      sessions: [],
      movementCount: 0,
      bucketReconciliationCount: 0,
      clearBucketCount: 0,
      productReconciliationCount: 0
    }
    const repository = openingRepository({
      [PRODUCT_ID]: product(PRODUCT_ID, EXPIRY_TRACKING.TRACKED)
    }, [], {}, events)
    const writer = createOpeningCountWriter(repository)
    const plan = previewOpeningCount({
      operationId: 'opening-reuse-1',
      rows: [
        { productId: PRODUCT_ID, countedQuantity: 0, expiryDate: '2026-12-30' },
        { productId: PRODUCT_ID, countedQuantity: 2, expiryDate: '2026-12-31' }
      ]
    }, auth).plan
    await writer(plan, { actorId: ACTOR_ID, approvedBy: ACTOR_ID, approvalId: 'approval-reuse-1' })
    expect(await writerErrorCode(writer, plan, { actorId: ACTOR_ID, approvedBy: ACTOR_ID, approvalId: 'approval-reuse-2' })).to.equal(STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT)
    const conflictingPlan = previewOpeningCount({
      operationId: plan.operationId,
      rows: [{ productId: PRODUCT_ID, countedQuantity: 3, expiryDate: '2026-12-31' }]
    }, auth).plan
    expect(await writerErrorCode(writer, conflictingPlan, { actorId: ACTOR_ID, approvedBy: ACTOR_ID, approvalId: 'approval-reuse-1' })).to.equal(STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT)
    expect(events.movementCount).to.equal(1)
    expect(events.bucketReconciliationCount).to.equal(1)
    expect(events.productReconciliationCount).to.equal(1)
    expect(new Set(events.sessions).size).to.equal(1)
  })
})
