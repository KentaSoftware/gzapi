import { expect } from 'chai'
import { performance } from 'node:perf_hooks'

import {
  BASELINE_STATUS,
  EXPIRY_TRACKING,
  type StockBucketProjectionDelta,
  type StockBucketSnapshot,
  type StockMinimumResult,
  type StockMovementQuery,
  type StockMovementRecord,
  type StockProductMinimum,
  type StockProductOverviewPage,
  type StockProductProjectionDelta,
  type StockProductSnapshot,
  type StockRepository,
  type StockRepositorySession,
  type StockServiceAuth,
  type StockTransactionContext
} from '../src/interfaces/stock.interface'
import { StockService } from '../src/services/stock'

const NFR_001 = {
  PRODUCT_COUNT: 774,
  SALE_ITEM_LINE_COUNT: 51822,
  CONCURRENCY: 10,
  WARM_UP_COUNT: 2,
  PAGE: 1,
  PAGE_SIZE: 100,
  P95_PERCENTILE: 0.95,
  P95_LIMIT_MS: 5000
} as const

const BUSINESS_DATE = '2026-10-15'

interface SaleItemLineFixture {
  lineId: string
  productId: string
  quantity: number
}

class PerformanceStockRepository implements StockRepository {
  readonly products: Map<string, StockProductSnapshot>
  readonly saleItemLines: SaleItemLineFixture[]

  constructor () {
    this.products = new Map<string, StockProductSnapshot>()
    for (let index = 0; index < NFR_001.PRODUCT_COUNT; index += 1) {
      const productId = `performance-product-${String(index + 1).padStart(4, '0')}`
      this.products.set(productId, {
        productId,
        physicalQuantity: 100,
        committedQuantity: 10,
        availableQuantity: 90,
        expiryTracking: EXPIRY_TRACKING.NOT_TRACKED,
        baselineStatus: BASELINE_STATUS.RECONCILED
      })
    }

    // Sale history is fixture metadata only; the approved overview MVP does not aggregate it.
    this.saleItemLines = Array.from({ length: NFR_001.SALE_ITEM_LINE_COUNT }, (_, index) => ({
      lineId: `performance-sale-line-${index + 1}`,
      productId: `performance-product-${String((index % NFR_001.PRODUCT_COUNT) + 1).padStart(4, '0')}`,
      quantity: (index % 5) + 1
    }))
  }

  async withTransaction<T> (work: (context: StockRepository & StockTransactionContext) => Promise<T>): Promise<T> {
    const context = Object.assign(this, { session: { transactionId: 'performance-transaction' } })
    return await work(context)
  }

  async getProduct (productId: string, _session?: StockRepositorySession): Promise<StockProductSnapshot | undefined> {
    return this.products.get(productId)
  }

  async getProductMinimum (productId: string, _session?: StockRepositorySession): Promise<StockProductMinimum | undefined> {
    if (!this.products.has(productId)) return undefined
    return { productId, minimum: 20 }
  }

  async listProducts (page: number, pageSize: number, _session?: StockRepositorySession): Promise<StockProductOverviewPage> {
    const records = [...this.products.values()].map((snapshot) => ({
      productId: snapshot.productId,
      minimum: 20,
      snapshot
    }))
    const start = (page - 1) * pageSize
    return { total: records.length, items: records.slice(start, start + pageSize) }
  }

  async updateProductMinimum (_productId: string, _minimum: number, _session?: StockRepositorySession): Promise<StockMinimumResult | undefined> {
    throw new Error('Performance fixture does not support mutations')
  }

  async getBuckets (_productId: string, _session?: StockRepositorySession): Promise<StockBucketSnapshot[]> {
    return []
  }

  async getBucket (_bucketId: string, _session?: StockRepositorySession): Promise<StockBucketSnapshot | undefined> {
    return undefined
  }

  async findMovementByIdempotencyKey (_idempotencyKey: string, _session?: StockRepositorySession): Promise<StockMovementRecord | undefined> {
    return undefined
  }

  async findMovements (_query: StockMovementQuery, _session?: StockRepositorySession): Promise<StockMovementRecord[]> {
    return []
  }

  async insertMovement (_movement: StockMovementRecord, _session?: StockRepositorySession): Promise<StockMovementRecord> {
    throw new Error('Performance fixture does not support mutations')
  }

  async applyPhysicalBucketReceipt (_productId: string, _expiryDate: string, _quantity: number, _session?: StockRepositorySession): Promise<StockBucketSnapshot> {
    throw new Error('Performance fixture does not support mutations')
  }

  async applyBucketProjectionDelta (_bucketId: string, _delta: StockBucketProjectionDelta, _session?: StockRepositorySession): Promise<void> {
    throw new Error('Performance fixture does not support mutations')
  }

  async applyProductProjectionDelta (_productId: string, _delta: StockProductProjectionDelta, _session?: StockRepositorySession): Promise<void> {
    throw new Error('Performance fixture does not support mutations')
  }
}

const overviewQuery = (actorId: string): {
  businessDate: string
  page: number
  pageSize: number
  auth: StockServiceAuth
} => ({
  businessDate: BUSINESS_DATE,
  page: NFR_001.PAGE,
  pageSize: NFR_001.PAGE_SIZE,
  auth: { actorId, canManageStock: false }
})

describe('Stock performance — NFR-001', () => {
  it('keeps bounded concurrent overview p95 within five seconds', async () => {
    const repository = new PerformanceStockRepository()
    const service = new StockService(repository)

    for (let index = 0; index < NFR_001.WARM_UP_COUNT; index += 1) {
      await service.getOverview(overviewQuery(`warm-up-user-${index + 1}`))
    }

    const durations = await Promise.all(Array.from({ length: NFR_001.CONCURRENCY }, async (_, index) => {
      const startedAt = performance.now()
      const overview = await service.getOverview(overviewQuery(`concurrent-user-${index + 1}`))
      const duration = performance.now() - startedAt
      expect(overview.total).to.equal(NFR_001.PRODUCT_COUNT)
      expect(overview.items).to.have.lengthOf(NFR_001.PAGE_SIZE)
      return duration
    }))

    const sortedDurations = [...durations].sort((left, right) => left - right)
    const p95Index = Math.ceil(NFR_001.P95_PERCENTILE * sortedDurations.length) - 1
    const p95 = sortedDurations[p95Index]
    const maxResponse = sortedDurations[sortedDurations.length - 1]
    const benchmarkLine = `NFR-001 Stock performance products=${repository.products.size} saleItemLines=${repository.saleItemLines.length} concurrency=${NFR_001.CONCURRENCY} warmUp=${NFR_001.WARM_UP_COUNT} p95Ms=${p95.toFixed(2)} maxMs=${maxResponse.toFixed(2)} runtime=${process.version} environment=${process.platform}/${process.arch}`

    console.info(benchmarkLine)
    expect(p95, benchmarkLine).to.be.at.most(NFR_001.P95_LIMIT_MS)
  })
})
