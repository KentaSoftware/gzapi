import { createHash } from 'node:crypto'
import {
  BASELINE_STATUS,
  EXPIRY_TRACKING,
  INVENTORY_MOVEMENT_TYPES,
  STOCK_DATA_QUALITY,
  STOCK_LATEST_SALE_STATUS,
  STOCK_ALERT_SEVERITIES,
  STOCK_ALERT_TYPES,
  STOCK_ERROR_CODES,
  STOCK_OPERATION_STATUSES,
  type AvailabilityResult,
  type FefoAllocationResult,
  type StockAggregatedLine,
  type StockAvailabilityQuery,
  type StockAvailabilityValidationResult,
  type StockAlert,
  type StockBucketSnapshot,
  type StockIdempotentMovementResult,
  type StockMovementRecord,
  type StockOperationInput,
  type StockOperationResult,
  type StockProductSnapshot,
  type StockOverviewItem,
  type StockOverviewQuery,
  type StockOverviewResult,
  type StockOverviewGlobalSummary,
  type StockGlobalAlert,
  type StockProductDetailQuery,
  type StockProductDetailResult,
  type StockMinimumResult,
  type StockMinimumAuditRecord,
  type StockMinimumUpdateOptions,
  type StockPhysicalReturnInput,
  type StockPhysicalReturnLineInput,
  type PurchaseReceiptInput,
  type PurchaseAdjustmentInput,
  type ExpiredRemovalInput,
  type StockWriteOffInput,
  type ExpiredProductRemovalInput,
  type ExpiredProductRemovalResult,
  type ExpiredBulkRemovalInput,
  type ExpiredBulkRemovalResult,
  type StockRepository,
  type StockRotationInput,
  type SaleDeliveryInput,
  type StockSaleAdjustmentInput,
  type StockSaleAvailabilityInput,
  type StockSaleCancelInput,
  type StockSaleCommitInput,
  type StockSaleLineInput,
  type StockSaleReleaseInput,
  type StockServiceAuth,
  type StockTransactionContext
} from '../interfaces/stock.interface'
import { STOCK_EXPIRY_ALERT_DAYS, STOCK_RULES_VERSION, STOCK_TIME_ZONE } from '../config/stock'
import { allocateFefo, calculateAvailability, evaluateExpiry, evaluateLowRotation, evaluateLowStock, StockRuleError } from './stockRules'

const SOURCE_TYPE = 'SALE'
const PURCHASE_SOURCE_TYPE = 'PURCHASE'
const SOURCE_EVENTS = {
  COMMIT: 'SALE_COMMIT',
  CANCEL: 'SALE_CANCEL',
  ADJUSTMENT: 'SALE_ADJUSTMENT'
} as const

const PURCHASE_SOURCE_EVENTS = {
  RECEIPT: 'PURCHASE_RECEIPT',
  ADJUSTMENT: 'PURCHASE_ADJUSTMENT'
} as const

const EXPIRY_SOURCE_TYPE = 'EXPIRY_BUCKET'
const STOCK_SOURCE_TYPE = 'STOCK'
const STOCK_ROTATION_DAYS = 90

const DELIVERY_SOURCE_EVENTS = {
  DELIVERED: 'SALE_DELIVERY'
} as const

const RETURN_SOURCE_EVENTS = {
  RETURN: 'SALE_RETURN'
} as const

type StockSourceEvent = (typeof SOURCE_EVENTS)[keyof typeof SOURCE_EVENTS]

export interface StockServiceOptions {
  timeZone?: string
  rulesVersion?: string
}

export class StockServiceError extends Error {
  readonly code: (typeof STOCK_ERROR_CODES)[keyof typeof STOCK_ERROR_CODES]
  diagnostic?: StockFailureDiagnostic

  constructor (code: (typeof STOCK_ERROR_CODES)[keyof typeof STOCK_ERROR_CODES], message: string) {
    super(message)
    this.name = 'StockServiceError'
    this.code = code
  }
}

const STOCK_FAILURE_OPERATIONS = {
  REPOSITORY_UNKNOWN: 'stock_repository_unknown',
  LIST_PRODUCTS: 'stock_overview_list_products',
  SALES_HISTORY: 'stock_overview_sales_history',
  AVAILABILITY: 'stock_overview_availability',
  EXPIRY_BUCKETS: 'stock_overview_expiry_buckets'
} as const

type StockFailureOperation = (typeof STOCK_FAILURE_OPERATIONS)[keyof typeof STOCK_FAILURE_OPERATIONS]

const STOCK_FAILURE_CAUSES = {
  DUPLICATE_KEY: 'duplicate_key',
  WRITE_CONFLICT: 'write_conflict',
  CONNECTION: 'connection',
  TIMEOUT: 'timeout',
  UNKNOWN: 'unknown'
} as const

type StockFailureCause = (typeof STOCK_FAILURE_CAUSES)[keyof typeof STOCK_FAILURE_CAUSES]

interface StockFailureDiagnostic {
  operation: StockFailureOperation
  cause: StockFailureCause
  databaseCode?: number
}

export const stockFailureDiagnosticOf = (operation: StockFailureOperation, error: unknown): StockFailureDiagnostic => {
  const name = error instanceof Error ? error.name : ''
  const allowedNames = ['MongoServerError', 'MongoNetworkError', 'MongoServerSelectionError', 'MongoNetworkTimeoutError', 'MongoTimeoutError']
  const allowedError = allowedNames.includes(name)
  let code: unknown
  if (allowedError && typeof error === 'object' && error !== null) {
    try {
      code = Object.getOwnPropertyDescriptor(error, 'code')?.value
    } catch {
      code = undefined
    }
  }
  const databaseCode = typeof code === 'number' && Number.isSafeInteger(code) ? code : undefined
  const cause = databaseCode === 11000 || databaseCode === 11001
    ? STOCK_FAILURE_CAUSES.DUPLICATE_KEY
    : databaseCode === 112
      ? STOCK_FAILURE_CAUSES.WRITE_CONFLICT
      : name === 'MongoServerSelectionError' || name === 'MongoNetworkError'
        ? STOCK_FAILURE_CAUSES.CONNECTION
        : databaseCode === 50 || databaseCode === 89 || databaseCode === 262 || name === 'MongoNetworkTimeoutError' || name === 'MongoTimeoutError'
          ? STOCK_FAILURE_CAUSES.TIMEOUT
          : STOCK_FAILURE_CAUSES.UNKNOWN
  return { operation, cause, ...(databaseCode === undefined ? {} : { databaseCode }) }
}

const withOverviewDiagnostic = async <T>(operation: StockFailureOperation, work: () => Promise<T>): Promise<T> => {
  try {
    return await work()
  } catch (error) {
    if (error instanceof StockServiceError && error.code === STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR) {
      const cause = error.diagnostic?.cause ?? STOCK_FAILURE_CAUSES.UNKNOWN
      const databaseCode = error.diagnostic?.databaseCode
      error.diagnostic = { operation, cause, ...(databaseCode === undefined ? {} : { databaseCode }) }
    } else if (error instanceof Error) Object.assign(error, { diagnostic: stockFailureDiagnosticOf(operation, error) })
    throw error
  }
}

const isPositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0

const isNonZeroSafeInteger = (value: number): boolean => Number.isSafeInteger(value) && value !== 0

const isNonNegativeSafeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0

const STOCK_MINIMUM_AUDIT_LIMITS = {
  CORRELATION_ID: 128,
  REASON: 200
} as const

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/

const purchaseAdjustmentSourceLineId = (buyId: string, lineId: string): string => {
  if (OBJECT_ID_PATTERN.test(lineId)) return lineId
  return createHash('sha256')
    .update(`stock-purchase-adjustment-source-line:v1:${buyId}:${lineId}`, 'utf8')
    .digest('hex')
    .slice(0, 24)
}

const operationResult = (operationId: string, appliedMovementCount: number, alreadyAppliedCount: number, projectionCount: number): StockOperationResult => ({
  status: STOCK_OPERATION_STATUSES.APPLIED,
  operationId,
  movementCount: appliedMovementCount,
  appliedMovementCount,
  alreadyAppliedCount,
  projectionCount
})

const incompleteAvailability = (productId: string): AvailabilityResult => ({
  productId,
  availableToSell: 0,
  physicalQuantity: 0,
  committedQuantity: 0,
  expiredQuantity: 0,
  dataQuality: STOCK_DATA_QUALITY.INCOMPLETE
})

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : 'Stock repository operation failed'

const hasSameMovementSemantics = (left: StockMovementRecord, right: StockMovementRecord): boolean =>
  left.productId === right.productId &&
  left.expiryBucketId === right.expiryBucketId &&
  left.type === right.type &&
  left.quantity === right.quantity &&
  left.sourceType === right.sourceType &&
  left.sourceId === right.sourceId &&
  left.sourceEvent === right.sourceEvent &&
  left.operationId === right.operationId &&
  left.sourceLineId === right.sourceLineId &&
  left.rulesVersion === right.rulesVersion &&
  left.createdBy === right.createdBy &&
  left.reason === right.reason &&
  left.note === right.note &&
  left.reversesMovementId === right.reversesMovementId

const validAuth = (auth: StockServiceAuth | undefined): boolean =>
  auth !== undefined && typeof auth.actorId === 'string' && auth.actorId.trim() !== ''

const validIdentity = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

const isCivilDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

const dateTimeOf = (value: unknown, field: string): Date => {
  if (!validIdentity(value)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `${field} is required`)
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `${field} is invalid`)
  return date
}

const validateReceipt = (input: PurchaseReceiptInput): Date => {
  if (!validIdentity(input.receivedBy)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_FORBIDDEN, 'A valid stock actor is required')
  if (!validIdentity(input.buyId) || !validIdentity(input.operationId) || !Array.isArray(input.lines) || input.lines.length === 0) {
    throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Purchase receipt identity is incomplete')
  }
  for (const line of input.lines) {
    if (typeof line !== 'object' || line === null || !validIdentity(line.itemBuyId) || !validIdentity(line.productId) || !isPositiveInteger(line.quantityReceived)) {
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Purchase receipt lines are incomplete')
    }
    if (line.expiryDate !== undefined && !isCivilDate(line.expiryDate)) {
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Purchase receipt expiryDate must be a valid civil date')
    }
  }
  if (input.businessDate !== undefined && !isCivilDate(input.businessDate)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'businessDate must be a valid civil date')
  return dateTimeOf(input.receivedAt, 'receivedAt')
}

const validateDelivery = (input: SaleDeliveryInput): Date => {
  if (!validIdentity(input.deliveredBy)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_FORBIDDEN, 'A valid stock actor is required')
  if (!validIdentity(input.saleId) || !validIdentity(input.operationId)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Sale delivery identity is incomplete')
  if (input.businessDate !== undefined && !isCivilDate(input.businessDate)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'businessDate must be a valid civil date')
  return dateTimeOf(input.deliveredAt, 'deliveredAt')
}

const validatePurchaseAdjustment = (input: PurchaseAdjustmentInput): Date => {
  if (!validAuth(input.auth)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_FORBIDDEN, 'A valid stock actor is required')
  if (!validIdentity(input.buyId) || !validIdentity(input.operationId) || !isCivilDate(input.businessDate) || !validIdentity(input.reason) || !Array.isArray(input.lines) || input.lines.length === 0) {
    throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Purchase adjustment identity is incomplete')
  }
  const lineIds = new Set<string>()
  for (const line of input.lines) {
    if (typeof line !== 'object' || line === null || !validIdentity(line.lineId) || lineIds.has(line.lineId) || !validIdentity(line.productId) || !isNonZeroSafeInteger(line.quantity)) {
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Purchase adjustment lines are incomplete')
    }
    lineIds.add(line.lineId)
    if (line.expiryDate !== undefined && !isCivilDate(line.expiryDate)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Purchase adjustment expiryDate must be a valid civil date')
  }
  if (input.occurredAt !== undefined && (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime()))) {
    throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'occurredAt is invalid')
  }
  return input.occurredAt ?? new Date()
}

const validateExpiredRemoval = (input: ExpiredRemovalInput): Date => {
  if (!validAuth(input.auth)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_FORBIDDEN, 'A valid stock actor is required')
  if (!validIdentity(input.bucketId) || !validIdentity(input.operationId) || !isCivilDate(input.businessDate) || !validIdentity(input.reason)) {
    throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Expired bucket removal identity is incomplete')
  }
  if (input.occurredAt !== undefined && (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime()))) {
    throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'occurredAt is invalid')
  }
  return input.occurredAt ?? new Date()
}

const validateStockWriteOff = (input: StockWriteOffInput): Date => {
  if (!validAuth(input.auth)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_FORBIDDEN, 'A valid stock actor is required')
  if (!validIdentity(input.productId) || !validIdentity(input.operationId) || !isCivilDate(input.businessDate) || !isPositiveInteger(input.quantity) || input.reason !== 'vencimiento') {
    throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Stock write-off input is incomplete or invalid')
  }
  if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 250)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'note must not exceed 250 characters')
  if (input.occurredAt !== undefined && (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime()))) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'occurredAt is invalid')
  return input.occurredAt ?? new Date()
}

const validateExpiredProductRemoval = (input: ExpiredProductRemovalInput): Date => {
  if (!validAuth(input.auth)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_FORBIDDEN, 'A valid stock actor is required')
  if (!validIdentity(input.productId) || !validIdentity(input.operationId) || !isCivilDate(input.businessDate)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Expired product removal input is incomplete or invalid')
  if (input.occurredAt !== undefined && (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime()))) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'occurredAt is invalid')
  return input.occurredAt ?? new Date()
}

const validatePhysicalReturn = (input: StockPhysicalReturnInput): Date => {
  validateOperation(input)
  if (!isCivilDate(input.businessDate)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'businessDate must be a valid civil date')
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'At least one physical return line is required')
  for (const line of input.lines) {
    if (typeof line !== 'object' || line === null || !validIdentity(line.productId) || !isPositiveInteger(line.quantity) || (line.lineId !== undefined && !validIdentity(line.lineId))) {
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Physical return lines are incomplete')
    }
  }
  if (input.occurredAt !== undefined && (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime()))) {
    throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'occurredAt is invalid')
  }
  return input.occurredAt ?? new Date()
}

const aggregateLines = (lines: StockSaleLineInput[]): StockAggregatedLine[] => {
  const quantities = new Map<string, number>()
  for (const line of lines) {
    if (typeof line.lineId !== 'string' || line.lineId.trim() === '' || typeof line.productId !== 'string' || line.productId.trim() === '' || !isPositiveInteger(line.quantity)) {
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Sale lines are incomplete')
    }
    quantities.set(line.productId, (quantities.get(line.productId) ?? 0) + line.quantity)
  }
  if (quantities.size === 0) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'At least one sale line is required')
  return [...quantities.entries()].map(([productId, quantity]) => ({ productId, quantity }))
}

const validateOperation = (input: StockOperationInput): void => {
  if (!validAuth(input.auth)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_FORBIDDEN, 'A valid stock actor is required')
  if (typeof input.saleId !== 'string' || input.saleId.trim() === '' || typeof input.operationId !== 'string' || input.operationId.trim() === '' || typeof input.businessDate !== 'string' || input.businessDate.trim() === '') {
    throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Stock operation identity is incomplete')
  }
}

const sourceLineId = (movement: StockMovementRecord): string | undefined => movement.sourceLineId

const compatibleRetryMovement = (movement: StockMovementRecord, input: StockOperationInput, line: StockSaleLineInput, type: StockMovementRecord['type'], sourceEvent: StockSourceEvent, rulesVersion: string, reason?: string): boolean => {
  const expected: StockMovementRecord = {
    ...movement,
    productId: line.productId,
    expiryBucketId: movement.expiryBucketId,
    type,
    sourceType: SOURCE_TYPE,
    sourceId: input.saleId,
    sourceEvent,
    operationId: input.operationId,
    sourceLineId: line.lineId,
    rulesVersion,
    createdBy: input.auth.actorId,
    reason,
    reversesMovementId: undefined
  }
  return hasSameMovementSemantics(movement, expected)
}

const compatibleRetryBatch = (movements: StockMovementRecord[], input: StockOperationInput, line: StockSaleLineInput, type: StockMovementRecord['type'], sourceEvent: StockSourceEvent, rulesVersion: string, reason?: string): boolean => {
  if (movements.length === 0 || movements.reduce((total, movement) => total + movement.quantity, 0) !== line.quantity) return false
  return movements.every((movement) => compatibleRetryMovement(movement, input, line, type, sourceEvent, rulesVersion, reason))
}

export class StockService {
  private readonly repository: StockRepository
  private readonly timeZone: string
  private readonly rulesVersion: string

  constructor (repository: StockRepository, options: StockServiceOptions = {}) {
    this.repository = repository
    this.timeZone = options.timeZone ?? STOCK_TIME_ZONE
    this.rulesVersion = options.rulesVersion ?? STOCK_RULES_VERSION
  }

  async getAvailability (query: StockAvailabilityQuery): Promise<AvailabilityResult[]> {
    if (!validAuth(query.auth)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_FORBIDDEN, 'A valid stock actor is required')
    if (!Array.isArray(query.productIds) || query.productIds.length === 0 || query.businessDate === undefined || query.businessDate.trim() === '') {
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Availability query is incomplete')
    }
    return await Promise.all(query.productIds.map(async (productId) => await this.readAvailability(this.repository, productId, query.businessDate as string, query.timeZone ?? this.timeZone)))
  }

  async getOverview (query: StockOverviewQuery): Promise<StockOverviewResult> {
    if (!validAuth(query.auth)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_FORBIDDEN, 'A valid stock actor is required')
    if (!isCivilDate(query.businessDate) || !isPositiveInteger(query.page) || !isPositiveInteger(query.pageSize) || query.pageSize > 100) {
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Stock overview query is incomplete or invalid')
    }
    const timeZone = query.timeZone ?? this.timeZone
    const filters = {
      ...(query.search === undefined ? {} : { search: query.search }),
      ...(query.category === undefined ? {} : { category: query.category })
    }
    const hasFilters = Object.keys(filters).length > 0
    const page = await withOverviewDiagnostic(STOCK_FAILURE_OPERATIONS.LIST_PRODUCTS, async () => await this.repository.listProducts(query.page, query.pageSize, undefined, hasFilters ? filters : undefined))
    const histories = await withOverviewDiagnostic(STOCK_FAILURE_OPERATIONS.SALES_HISTORY, async () => await this.repository.getSalesHistory(page.items.map(({ productId }) => productId), query.businessDate, STOCK_ROTATION_DAYS, timeZone))
    const historiesByProduct = new Map(histories.map((history) => [history.productId, history]))
    let latestSales = [] as Awaited<ReturnType<StockRepository['getLatestSales']>>
    try {
      latestSales = await this.repository.getLatestSales(page.items.map(({ productId }) => productId))
    } catch {
      // A failed authoritative read cannot establish a latest sale or lifetime absence.
    }
    const latestSalesByProduct = new Map(latestSales.flatMap(({ productId, occurredAt }) =>
      Number.isNaN(occurredAt.getTime()) ? [] : [[productId, occurredAt] as const]
    ))
    const items = await Promise.all(page.items.map(async (record): Promise<StockOverviewItem> => {
      const availability = await withOverviewDiagnostic(STOCK_FAILURE_OPERATIONS.AVAILABILITY, async () => await this.readAvailability(this.repository, record.productId, query.businessDate, timeZone))
      const buckets = await withOverviewDiagnostic(STOCK_FAILURE_OPERATIONS.EXPIRY_BUCKETS, async () => await this.repository.getBuckets(record.productId))
      const expiryAlertDays = record.expiryAlertDays ?? STOCK_EXPIRY_ALERT_DAYS
      const alerts = this.alertsFor(record.productId, availability, record.minimum, buckets, query.businessDate, timeZone, historiesByProduct.get(record.productId), expiryAlertDays)
      return {
        productId: record.productId,
        productName: record.productName,
        ...(record.categoryName === undefined ? {} : { categoryName: record.categoryName }),
        ...(record.imagePath === undefined ? {} : { imagePath: record.imagePath }),
        physicalQuantity: availability.physicalQuantity,
        committedQuantity: availability.committedQuantity,
        availableToSell: availability.availableToSell,
        expiredQuantity: availability.expiredQuantity,
        dataQuality: availability.dataQuality,
        minimum: record.minimum,
        expiryAlertDays,
        alerts,
        latestSale: latestSalesByProduct.has(record.productId)
          ? { status: STOCK_LATEST_SALE_STATUS.RECORDED, occurredAt: (latestSalesByProduct.get(record.productId) as Date).toISOString() }
          : { status: STOCK_LATEST_SALE_STATUS.INCOMPLETE }
      }
    }))
    const catalogTotal = hasFilters
      ? (await withOverviewDiagnostic(STOCK_FAILURE_OPERATIONS.LIST_PRODUCTS, async () => await this.repository.listProducts(1, 1))).total
      : page.total
    const { summary: globalSummary, alerts: globalAlerts } = await this.getGlobalOverviewData(catalogTotal, query.businessDate, timeZone)
    return {
      page: query.page,
      pageSize: query.pageSize,
      total: page.total,
      items,
      summary: {
        // Summary values intentionally describe only this page; total is the global count.
        productCount: items.length,
        physicalQuantity: items.reduce((total, item) => total + item.physicalQuantity, 0),
        committedQuantity: items.reduce((total, item) => total + item.committedQuantity, 0),
        availableToSell: items.reduce((total, item) => total + item.availableToSell, 0),
        alertCount: items.reduce((total, item) => total + item.alerts.length, 0)
      },
      globalSummary,
      globalAlerts
    }
  }

  private async getGlobalOverviewData (totalProducts: number, businessDate: string, timeZone: string): Promise<{ summary: StockOverviewGlobalSummary, alerts: StockGlobalAlert[] }> {
    const summary: StockOverviewGlobalSummary = {
      belowMinimumProductCount: 0,
      expiringProductCount: 0,
      expiredProductCount: 0,
      lowRotationProductCount: 0,
      activeAlertCount: 0
    }
    const pageSize = 100
    const pageCount = Math.ceil(totalProducts / pageSize)
    const globalAlerts: StockGlobalAlert[] = []
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const records = (await withOverviewDiagnostic(STOCK_FAILURE_OPERATIONS.LIST_PRODUCTS, async () => await this.repository.listProducts(pageNumber, pageSize))).items
      const histories = await withOverviewDiagnostic(STOCK_FAILURE_OPERATIONS.SALES_HISTORY, async () => await this.repository.getSalesHistory(records.map(({ productId }) => productId), businessDate, STOCK_ROTATION_DAYS, timeZone))
      const historiesByProduct = new Map(histories.map((history) => [history.productId, history]))
      const batchAlerts = await Promise.all(records.map(async (record) => {
        const availability = await withOverviewDiagnostic(STOCK_FAILURE_OPERATIONS.AVAILABILITY, async () => await this.readAvailability(this.repository, record.productId, businessDate, timeZone))
        const buckets = await withOverviewDiagnostic(STOCK_FAILURE_OPERATIONS.EXPIRY_BUCKETS, async () => await this.repository.getBuckets(record.productId))
        return this.alertsFor(record.productId, availability, record.minimum, buckets, businessDate, timeZone, historiesByProduct.get(record.productId), record.expiryAlertDays ?? STOCK_EXPIRY_ALERT_DAYS).map((alert) => ({ ...alert, productName: record.productName }))
      }))
      for (const alerts of batchAlerts) {
        const hasCompleteAlert = (type: StockAlert['type']): boolean => alerts.some((alert) => alert.type === type && alert.dataQuality === STOCK_DATA_QUALITY.COMPLETE)
        if (hasCompleteAlert(STOCK_ALERT_TYPES.LOW_STOCK) || hasCompleteAlert(STOCK_ALERT_TYPES.CRITICAL_STOCK)) summary.belowMinimumProductCount += 1
        if (hasCompleteAlert(STOCK_ALERT_TYPES.EXPIRING_SOON)) summary.expiringProductCount += 1
        if (hasCompleteAlert(STOCK_ALERT_TYPES.EXPIRED)) summary.expiredProductCount += 1
        if (hasCompleteAlert(STOCK_ALERT_TYPES.LOW_ROTATION)) summary.lowRotationProductCount += 1
        summary.activeAlertCount += alerts.length
        globalAlerts.push(...alerts)
      }
    }
    globalAlerts.sort((left, right) => {
      const productComparison = left.productId.localeCompare(right.productId)
      if (productComparison !== 0) return productComparison
      const typeComparison = left.type.localeCompare(right.type)
      return typeComparison !== 0 ? typeComparison : left.explanation.localeCompare(right.explanation)
    })
    return { summary, alerts: globalAlerts }
  }

  async getProductDetail (query: StockProductDetailQuery): Promise<StockProductDetailResult> {
    if (!validAuth(query.auth)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_FORBIDDEN, 'A valid stock actor is required')
    if (!validIdentity(query.productId) || !isCivilDate(query.businessDate) || !isPositiveInteger(query.movementLimit) || query.movementLimit > 100) {
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Stock product detail query is incomplete or invalid')
    }
    const timeZone = query.timeZone ?? this.timeZone
    const product = await this.repository.getProduct(query.productId)
    if (product === undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_PRODUCT_NOT_FOUND, `Product ${query.productId} was not found`)
    const minimum = await this.repository.getProductMinimum(query.productId)
    if (minimum === undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_PRODUCT_NOT_FOUND, `Product ${query.productId} was not found`)
    const [availability, buckets, movements, histories] = await Promise.all([
      this.readAvailability(this.repository, query.productId, query.businessDate, timeZone),
      this.repository.getBuckets(query.productId),
      this.repository.findMovements({ productId: query.productId, limit: query.movementLimit }),
      this.repository.getSalesHistory([query.productId], query.businessDate, STOCK_ROTATION_DAYS, timeZone)
    ])
    const orderedBuckets = [...buckets].sort((left, right) => {
      const expiryComparison = left.expiryDate.localeCompare(right.expiryDate)
      return expiryComparison !== 0 ? expiryComparison : left.bucketId.localeCompare(right.bucketId)
    })
    const orderedMovements = [...movements]
      .sort((left, right) => {
        const occurredAtComparison = right.occurredAt.getTime() - left.occurredAt.getTime()
        return occurredAtComparison !== 0 ? occurredAtComparison : (right.movementId ?? '').localeCompare(left.movementId ?? '')
      })
      .slice(0, query.movementLimit)
    return {
      productId: query.productId,
      minimum: minimum.minimum,
      expiryAlertDays: minimum.expiryAlertDays ?? STOCK_EXPIRY_ALERT_DAYS,
      availability,
      buckets: orderedBuckets,
      movements: orderedMovements,
      alerts: this.alertsFor(query.productId, availability, minimum.minimum, buckets, query.businessDate, timeZone, histories[0], minimum.expiryAlertDays ?? STOCK_EXPIRY_ALERT_DAYS)
    }
  }

  async updateMinimum (productId: string, minimum: number, auth: StockServiceAuth, options: StockMinimumUpdateOptions = {}): Promise<StockMinimumResult> {
    if (!validAuth(auth)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_FORBIDDEN, 'A valid stock actor is required')
    if (!isNonNegativeSafeInteger(minimum)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'minimum must be a safe non-negative integer')
    if (options.correlationId !== undefined && (options.correlationId.trim() === '' || options.correlationId.length > STOCK_MINIMUM_AUDIT_LIMITS.CORRELATION_ID)) {
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'correlationId must be a bounded identifier')
    }
    if (options.reason !== undefined && (options.reason.trim() === '' || options.reason.length > STOCK_MINIMUM_AUDIT_LIMITS.REASON)) {
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'reason must be a bounded string')
    }
    if (options.expiryAlertDays !== undefined && (!isNonNegativeSafeInteger(options.expiryAlertDays) || options.expiryAlertDays > 3650)) {
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'expiryAlertDays must be a safe integer between 0 and 3650')
    }
    try {
      return await this.runTransaction(`minimum-${productId}`, async (transaction) => {
        const previous = await transaction.getProductMinimum(productId, transaction.session)
        if (previous === undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_PRODUCT_NOT_FOUND, `Product ${productId} was not found`)
        const thresholdUnchanged = options.expiryAlertDays === undefined || previous.expiryAlertDays === options.expiryAlertDays
        if (previous.minimum === minimum && thresholdUnchanged) return { productId, minimum, ...(previous.expiryAlertDays === undefined ? {} : { expiryAlertDays: previous.expiryAlertDays }) }

        const result = await transaction.updateProductMinimum(productId, minimum, transaction.session, options.expiryAlertDays)
        if (result === undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_PRODUCT_NOT_FOUND, `Product ${productId} was not found`)
        if (previous.minimum === minimum) return result
        const audit: StockMinimumAuditRecord = {
          productId,
          actorId: auth.actorId,
          previousMinimum: previous.minimum,
          newMinimum: result.minimum,
          occurredAt: new Date(),
          ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
          ...(options.reason === undefined ? {} : { reason: options.reason })
        }
        await transaction.insertMinimumAudit(audit, transaction.session)
        return result
      })
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR, errorMessage(error))
    }
  }

  async writeOff (input: StockWriteOffInput): Promise<StockOperationResult> {
    const occurredAt = validateStockWriteOff(input)
    const trimmedNote = input.note?.trim()
    const note = trimmedNote === undefined || trimmedNote === '' ? undefined : trimmedNote
    return await this.runTransaction(input.operationId, async (transaction) => {
      const product = await transaction.getProduct(input.productId, transaction.session)
      if (product === undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_PRODUCT_NOT_FOUND, `Product ${input.productId} was not found`)
      if (!this.validProductSnapshot(product, input.productId) || product.physicalQuantity !== product.availableQuantity + product.committedQuantity) {
        throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Product projection is invalid for ${input.productId}`)
      }
      const existing = (await transaction.findMovements({
        productId: input.productId,
        sourceType: STOCK_SOURCE_TYPE,
        sourceId: input.productId,
        type: INVENTORY_MOVEMENT_TYPES.STOCK_WRITE_OFF
      }, transaction.session)).filter(({ operationId }) => operationId === input.operationId)
      if (existing.length > 0) {
        const totalQuantity = existing.reduce((total, movement) => total + movement.quantity, 0)
        const expectedEvent = `STOCK_WRITE_OFF:${input.businessDate}`
        if (totalQuantity !== input.quantity || existing.some((movement) =>
          movement.sourceEvent !== expectedEvent || movement.reason !== input.reason || movement.note !== note || movement.createdBy !== input.auth.actorId || movement.rulesVersion !== this.rulesVersion
        )) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT, `Operation ${input.operationId} conflicts with an existing write-off`)
        return operationResult(input.operationId, 0, existing.length, 0)
      }

      const buckets = await transaction.getBuckets(input.productId, transaction.session)
      if (!buckets.every(this.validBucketSnapshot) || buckets.some((bucket) => bucket.productId !== input.productId || bucket.receivedQuantity !== bucket.availableQuantity + bucket.committedQuantity)) {
        throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Physical bucket projection is invalid for ${input.productId}`)
      }
      if (product.expiryTracking === EXPIRY_TRACKING.TRACKED && (
        buckets.reduce((total, bucket) => total + bucket.receivedQuantity, 0) !== product.physicalQuantity ||
        buckets.reduce((total, bucket) => total + bucket.committedQuantity, 0) !== product.committedQuantity
      )) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Physical bucket projection does not match product ${input.productId}`)
      if (product.expiryTracking === EXPIRY_TRACKING.UNKNOWN || (product.expiryTracking === EXPIRY_TRACKING.NOT_TRACKED && buckets.length > 0) || (product.expiryTracking === EXPIRY_TRACKING.TRACKED && buckets.length === 0 && product.physicalQuantity > 0)) {
        throw new StockServiceError(STOCK_ERROR_CODES.STOCK_AVAILABILITY_UNAVAILABLE, `Expiry tracking is unavailable for ${input.productId}`)
      }

      const orderedBuckets = product.expiryTracking === EXPIRY_TRACKING.TRACKED
        ? [...buckets].sort((left, right) => {
            const expiryComparison = left.expiryDate.localeCompare(right.expiryDate)
            return expiryComparison !== 0 ? expiryComparison : left.bucketId.localeCompare(right.bucketId)
          })
        : []
      if (input.quantity > product.availableQuantity) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_INSUFFICIENT, `Insufficient uncommitted stock for ${input.productId}`)
      const allocations: Array<{ bucketId?: string, quantity: number }> = []
      if (product.expiryTracking === EXPIRY_TRACKING.TRACKED) {
        let remaining = input.quantity
        for (const bucket of orderedBuckets) {
          const quantity = Math.min(remaining, bucket.availableQuantity)
          if (quantity > 0) allocations.push({ bucketId: bucket.bucketId, quantity })
          remaining -= quantity
          if (remaining === 0) break
        }
        if (remaining > 0) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_INSUFFICIENT, `Insufficient uncommitted stock for ${input.productId}`)
      } else {
        allocations.push({ quantity: input.quantity })
      }

      let applied = 0
      let alreadyApplied = 0
      let projections = 0
      for (const allocation of allocations) {
        const idempotencyKey = `stock-write-off:${input.operationId}:${input.productId}:${allocation.bucketId ?? 'untracked'}`
        const movement: StockMovementRecord = {
          productId: input.productId,
          expiryBucketId: allocation.bucketId,
          type: INVENTORY_MOVEMENT_TYPES.STOCK_WRITE_OFF,
          quantity: allocation.quantity,
          occurredAt,
          sourceType: STOCK_SOURCE_TYPE,
          sourceId: input.productId,
          sourceEvent: `STOCK_WRITE_OFF:${input.businessDate}`,
          operationId: input.operationId,
          idempotencyKey,
          rulesVersion: this.rulesVersion,
          reason: input.reason,
          ...(note === undefined ? {} : { note }),
          createdBy: input.auth.actorId
        }
        const persisted = await this.persistMovement(transaction, movement)
        if (persisted.alreadyApplied) {
          alreadyApplied += 1
          continue
        }
        await this.applyStockWriteOffProjection(transaction, movement)
        applied += 1
        projections += allocation.bucketId === undefined ? 1 : 2
      }
      return operationResult(input.operationId, applied, alreadyApplied, projections)
    })
  }

  async removeExpiredProduct (input: ExpiredProductRemovalInput): Promise<ExpiredProductRemovalResult> {
    const occurredAt = validateExpiredProductRemoval(input)
    return await this.runTransaction(input.operationId, async (transaction) => {
      const product = await transaction.getProduct(input.productId, transaction.session)
      if (product === undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_PRODUCT_NOT_FOUND, `Product ${input.productId} was not found`)
      if (!this.validProductSnapshot(product, input.productId) || product.physicalQuantity !== product.availableQuantity + product.committedQuantity) {
        throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Product projection is invalid for ${input.productId}`)
      }
      if (product.expiryTracking !== EXPIRY_TRACKING.TRACKED) {
        if (product.expiryTracking === EXPIRY_TRACKING.UNKNOWN) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_AVAILABILITY_UNAVAILABLE, `Expiry tracking is unavailable for ${input.productId}`)
        if ((await transaction.getBuckets(input.productId, transaction.session)).length > 0) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Bucket data is invalid for ${input.productId}`)
        return { productId: input.productId, operationId: input.operationId, outcome: 'NO_ELIGIBLE', removedQuantity: 0, movementCount: 0 }
      }
      const buckets = await transaction.getBuckets(input.productId, transaction.session)
      if (!buckets.every(this.validBucketSnapshot) || buckets.some((bucket) => bucket.productId !== input.productId || bucket.receivedQuantity !== bucket.availableQuantity + bucket.committedQuantity)) {
        throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Physical bucket projection is invalid for ${input.productId}`)
      }
      if (buckets.reduce((total, bucket) => total + bucket.receivedQuantity, 0) !== product.physicalQuantity ||
        buckets.reduce((total, bucket) => total + bucket.committedQuantity, 0) !== product.committedQuantity) {
        throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Physical bucket projection does not match product ${input.productId}`)
      }
      const previous = (await transaction.findMovements({ productId: input.productId, sourceType: STOCK_SOURCE_TYPE, sourceId: input.productId, type: INVENTORY_MOVEMENT_TYPES.EXPIRED_REMOVAL }, transaction.session))
        .filter(({ operationId }) => operationId === input.operationId)
      if (previous.length > 0) {
        const expectedEvents = [`EXPIRED_REMOVAL:${input.businessDate}:PARTIAL`, `EXPIRED_REMOVAL:${input.businessDate}:FULL`]
        if (previous.some((movement) => !expectedEvents.includes(movement.sourceEvent) || movement.createdBy !== input.auth.actorId || movement.rulesVersion !== this.rulesVersion || movement.reason !== 'vencimiento' || movement.expiryBucketId === undefined || movement.idempotencyKey !== `expired-product-removal:${input.operationId}:${input.productId}:${movement.expiryBucketId}`)) {
          throw new StockServiceError(STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT, `Operation ${input.operationId} conflicts with an existing expired removal`)
        }
        const removedQuantity = previous.reduce((total, movement) => total + movement.quantity, 0)
        const partial = previous.some(({ sourceEvent }) => sourceEvent.endsWith(':PARTIAL'))
        return {
          productId: input.productId,
          operationId: input.operationId,
          outcome: partial ? 'PARTIAL' : 'REMOVED',
          removedQuantity,
          movementCount: previous.length
        }
      }

      const expiredBuckets = buckets.filter((bucket) => bucket.expiryDate < input.businessDate)
      const eligibleBuckets = expiredBuckets.filter((bucket) => bucket.availableQuantity > 0)
      const committedExpired = expiredBuckets.some((bucket) => bucket.committedQuantity > 0)
      const sourceEvent = `EXPIRED_REMOVAL:${input.businessDate}:${committedExpired ? 'PARTIAL' : 'FULL'}`
      let removedQuantity = 0
      let movementCount = 0
      for (const bucket of eligibleBuckets) {
        const idempotencyKey = `expired-product-removal:${input.operationId}:${input.productId}:${bucket.bucketId}`
        const movement: StockMovementRecord = {
          productId: input.productId,
          expiryBucketId: bucket.bucketId,
          type: INVENTORY_MOVEMENT_TYPES.EXPIRED_REMOVAL,
          quantity: bucket.availableQuantity,
          occurredAt,
          sourceType: STOCK_SOURCE_TYPE,
          sourceId: input.productId,
          sourceEvent,
          operationId: input.operationId,
          idempotencyKey,
          rulesVersion: this.rulesVersion,
          reason: 'vencimiento',
          createdBy: input.auth.actorId
        }
        const persisted = await this.persistMovement(transaction, movement)
        if (!persisted.alreadyApplied) {
          await this.applyExpiredRemovalProjection(transaction, movement)
          removedQuantity += movement.quantity
          movementCount += 1
        }
      }
      const outcome = removedQuantity === 0 ? 'NO_ELIGIBLE' : committedExpired ? 'PARTIAL' : 'REMOVED'
      return { productId: input.productId, operationId: input.operationId, outcome, removedQuantity, movementCount }
    })
  }

  async removeExpiredProducts (input: ExpiredBulkRemovalInput): Promise<ExpiredBulkRemovalResult> {
    if (!validAuth(input.auth)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_FORBIDDEN, 'A valid stock actor is required')
    if (!validIdentity(input.operationId) || !isCivilDate(input.businessDate) || !Array.isArray(input.productIds) || input.productIds.length === 0 || input.productIds.length > 100 || input.productIds.some((productId) => !validIdentity(productId)) || new Set(input.productIds).size !== input.productIds.length) {
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Bulk expired removal input is incomplete or invalid')
    }
    const results: ExpiredBulkRemovalResult['results'] = []
    for (const productId of input.productIds) {
      const productOperationId = createHash('sha256').update(`expired-bulk:v1:${input.operationId}:${productId}`, 'utf8').digest('hex').slice(0, 40)
      try {
        const result = await this.removeExpiredProduct({ productId, operationId: productOperationId, businessDate: input.businessDate, auth: input.auth })
        results.push({ productId, status: result.outcome, removedQuantity: result.removedQuantity })
      } catch (error) {
        results.push({ productId, status: 'FAILED', removedQuantity: 0, errorCode: error instanceof StockServiceError ? error.code : STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR })
      }
    }
    return { operationId: input.operationId, results }
  }

  async assertSaleAvailability (input: StockSaleAvailabilityInput): Promise<StockAvailabilityValidationResult> {
    if (!validAuth(input.auth)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_FORBIDDEN, 'A valid stock actor is required')
    const lines = aggregateLines(input.lines)
    const availability = await Promise.all(lines.map(async ({ productId }) => await this.readAvailability(this.repository, productId, input.businessDate, input.timeZone ?? this.timeZone)))
    for (const result of availability) {
      if (result.dataQuality !== STOCK_DATA_QUALITY.COMPLETE) {
        throw new StockServiceError(STOCK_ERROR_CODES.STOCK_AVAILABILITY_UNAVAILABLE, `Availability is unavailable for ${result.productId}`)
      }
      const requested = lines.find((line) => line.productId === result.productId)?.quantity ?? 0
      if (requested > result.availableToSell) {
        throw new StockServiceError(STOCK_ERROR_CODES.STOCK_INSUFFICIENT, `Insufficient stock for ${result.productId}: requested ${requested}, available ${result.availableToSell}`)
      }
    }
    return { saleId: input.saleId, lines, availability }
  }

  async commitSale (input: StockSaleCommitInput): Promise<StockOperationResult> {
    validateOperation(input)
    aggregateLines(input.lines)
    return await this.runTransaction(input.operationId, async (transaction) => {
      const previous = await transaction.findMovements({ sourceType: SOURCE_TYPE, sourceId: input.saleId, type: INVENTORY_MOVEMENT_TYPES.SALE_COMMIT }, transaction.session)
      const pendingLines: StockSaleLineInput[] = []
      let alreadyAppliedCount = 0
      for (const line of input.lines) {
        const previousForLine = previous.filter((movement) => sourceLineId(movement) === line.lineId)
        const retryMovements = previousForLine.filter((movement) => movement.operationId === input.operationId)
        if (retryMovements.length > 0) {
          if (!compatibleRetryBatch(retryMovements, input, line, INVENTORY_MOVEMENT_TYPES.SALE_COMMIT, SOURCE_EVENTS.COMMIT, this.rulesVersion)) {
            throw new StockServiceError(STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT, `Existing commitment conflicts for line ${line.lineId}`)
          }
          alreadyAppliedCount += retryMovements.length
        } else {
          pendingLines.push(line)
        }
      }

      if (pendingLines.length === 0) return operationResult(input.operationId, 0, alreadyAppliedCount, 0)
      await this.assertAvailabilityInTransaction(transaction, pendingLines, input.businessDate, input.timeZone ?? this.timeZone)
      const counters = await this.applyAdditions(transaction, input, pendingLines, INVENTORY_MOVEMENT_TYPES.SALE_COMMIT, SOURCE_EVENTS.COMMIT)
      return operationResult(input.operationId, counters.applied, alreadyAppliedCount + counters.alreadyApplied, counters.projections)
    })
  }

  async receivePurchase (input: PurchaseReceiptInput): Promise<StockOperationResult> {
    const occurredAt = validateReceipt(input)
    return await this.runTransaction(input.operationId, async (transaction) => {
      let applied = 0
      let alreadyApplied = 0
      let projections = 0
      for (const line of input.lines) {
        const product = await transaction.getProduct(line.productId, transaction.session)
        if (product === undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_AVAILABILITY_UNAVAILABLE, `Availability is unavailable for ${line.productId}`)
        if (!this.validProductSnapshot(product, line.productId)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Product projection is invalid for ${line.productId}`)
        if (product.expiryTracking === EXPIRY_TRACKING.UNKNOWN) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_AVAILABILITY_UNAVAILABLE, `Expiry tracking is unavailable for ${line.productId}`)
        if (product.expiryTracking === EXPIRY_TRACKING.TRACKED && line.expiryDate === undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Expiry date is required for ${line.productId}`)
        if (product.expiryTracking === EXPIRY_TRACKING.NOT_TRACKED && line.expiryDate !== undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Expiry date is not valid for ${line.productId}`)

        const idempotencyKey = `purchase-receipt:${input.operationId}:${input.buyId}:${line.itemBuyId}`
        const existing = await transaction.findMovementByIdempotencyKey(idempotencyKey, transaction.session)
        if (existing !== undefined) {
          const buckets = product.expiryTracking === EXPIRY_TRACKING.TRACKED ? await transaction.getBuckets(line.productId, transaction.session) : []
          const existingBucket = existing.expiryBucketId === undefined ? undefined : buckets.find((bucket) => bucket.bucketId === existing.expiryBucketId)
          const expectedBucketId = product.expiryTracking === EXPIRY_TRACKING.TRACKED ? existing.expiryBucketId : undefined
          const compatible = hasSameMovementSemantics(existing, {
            ...existing,
            productId: line.productId,
            expiryBucketId: expectedBucketId,
            type: INVENTORY_MOVEMENT_TYPES.PURCHASE_IN,
            quantity: line.quantityReceived,
            occurredAt,
            sourceType: PURCHASE_SOURCE_TYPE,
            sourceId: input.buyId,
            sourceEvent: PURCHASE_SOURCE_EVENTS.RECEIPT,
            operationId: input.operationId,
            idempotencyKey,
            rulesVersion: this.rulesVersion,
            sourceLineId: line.itemBuyId,
            createdBy: input.receivedBy
          }) && (product.expiryTracking !== EXPIRY_TRACKING.TRACKED || (existingBucket !== undefined && existingBucket.expiryDate === line.expiryDate))
          if (!compatible) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT, `Idempotency key conflicts: ${idempotencyKey}`)
          alreadyApplied += 1
          continue
        }

        let expiryBucketId: string | undefined
        if (product.expiryTracking === EXPIRY_TRACKING.TRACKED) {
          const bucket = await transaction.applyPhysicalBucketReceipt(line.productId, line.expiryDate as string, line.quantityReceived, transaction.session)
          if (!this.validBucketSnapshot(bucket) || bucket.productId !== line.productId || bucket.expiryDate !== line.expiryDate || bucket.receivedQuantity !== bucket.availableQuantity + bucket.committedQuantity) {
            throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Physical bucket projection is invalid for ${line.productId}`)
          }
          expiryBucketId = bucket.bucketId
        }
        const movement: StockMovementRecord = {
          productId: line.productId,
          expiryBucketId,
          type: INVENTORY_MOVEMENT_TYPES.PURCHASE_IN,
          quantity: line.quantityReceived,
          occurredAt,
          sourceType: PURCHASE_SOURCE_TYPE,
          sourceId: input.buyId,
          sourceEvent: PURCHASE_SOURCE_EVENTS.RECEIPT,
          operationId: input.operationId,
          idempotencyKey,
          rulesVersion: this.rulesVersion,
          sourceLineId: line.itemBuyId,
          createdBy: input.receivedBy
        }
        const persisted = await this.persistMovement(transaction, movement)
        if (persisted.alreadyApplied) {
          alreadyApplied += 1
          continue
        }
        await this.applyPhysicalProjection(transaction, movement)
        applied += 1
        projections += product.expiryTracking === EXPIRY_TRACKING.TRACKED ? 2 : 1
      }
      return operationResult(input.operationId, applied, alreadyApplied, projections)
    })
  }

  async adjustPurchase (input: PurchaseAdjustmentInput): Promise<StockOperationResult> {
    const occurredAt = validatePurchaseAdjustment(input)
    return await this.runTransaction(input.operationId, async (transaction) => {
      const previous = await transaction.findMovements({ sourceType: PURCHASE_SOURCE_TYPE, sourceId: input.buyId, type: INVENTORY_MOVEMENT_TYPES.PROJECTION_REPAIR }, transaction.session)
      const products = new Map<string, StockProductSnapshot>()
      const buckets = new Map<string, StockBucketSnapshot>()
      const productAvailableDelta = new Map<string, number>()
      const productPhysicalDelta = new Map<string, number>()
      const bucketAvailableDelta = new Map<string, number>()
      const bucketReceivedDelta = new Map<string, number>()
      const planned: Array<{ movement: StockMovementRecord, tracked: boolean, signedQuantity: number }> = []
      let alreadyApplied = 0

      for (const line of input.lines) {
        let product = products.get(line.productId)
        if (product === undefined) {
          product = await transaction.getProduct(line.productId, transaction.session)
          if (product === undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_AVAILABILITY_UNAVAILABLE, `Availability is unavailable for ${line.productId}`)
          if (!this.validProductSnapshot(product, line.productId) || product.physicalQuantity !== product.availableQuantity + product.committedQuantity) {
            throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Product projection is invalid for ${line.productId}`)
          }
          products.set(line.productId, product)
        }

        let targetBucket: StockBucketSnapshot | undefined
        let tracked = false
        if (product.expiryTracking === EXPIRY_TRACKING.TRACKED) {
          if (line.expiryDate === undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Expiry date is required for ${line.productId}`)
          const productBuckets = await transaction.getBuckets(line.productId, transaction.session)
          if (!productBuckets.every(this.validBucketSnapshot) || productBuckets.some((bucket) => bucket.productId !== line.productId || bucket.receivedQuantity !== bucket.availableQuantity + bucket.committedQuantity)) {
            throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Physical bucket projection is invalid for ${line.productId}`)
          }
          targetBucket = productBuckets.find((bucket) => bucket.expiryDate === line.expiryDate)
          if (targetBucket === undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_AVAILABILITY_UNAVAILABLE, `Expiry bucket is unavailable for ${line.productId}`)
          tracked = true
          buckets.set(targetBucket.bucketId, targetBucket)
        } else if (product.expiryTracking === EXPIRY_TRACKING.NOT_TRACKED) {
          if (line.expiryDate !== undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Expiry date is not valid for ${line.productId}`)
          const productBuckets = await transaction.getBuckets(line.productId, transaction.session)
          if (productBuckets.length > 0) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Bucket data is invalid for ${line.productId}`)
        } else {
          throw new StockServiceError(STOCK_ERROR_CODES.STOCK_AVAILABILITY_UNAVAILABLE, `Expiry tracking is unavailable for ${line.productId}`)
        }

        const direction = line.quantity < 0 ? 'negative' : 'positive'
        const idempotencyKey = `purchase-adjustment:${input.operationId}:${input.buyId}:${line.lineId}:${direction}`
        const movementLineId = purchaseAdjustmentSourceLineId(input.buyId, line.lineId)
        const previousForLine = previous.filter((movement) => movement.operationId === input.operationId && movement.sourceLineId === movementLineId)
        if (previousForLine.length > 0) {
          const existing = previousForLine.find((movement) => movement.idempotencyKey === idempotencyKey)
          if (existing === undefined || previousForLine.length !== 1 || !hasSameMovementSemantics(existing, {
            ...existing,
            productId: line.productId,
            expiryBucketId: targetBucket?.bucketId,
            type: INVENTORY_MOVEMENT_TYPES.PROJECTION_REPAIR,
            quantity: Math.abs(line.quantity),
            occurredAt,
            sourceType: PURCHASE_SOURCE_TYPE,
            sourceId: input.buyId,
            sourceEvent: PURCHASE_SOURCE_EVENTS.ADJUSTMENT,
            operationId: input.operationId,
            idempotencyKey,
            rulesVersion: this.rulesVersion,
            sourceLineId: movementLineId,
            reason: input.reason.trim(),
            createdBy: input.auth.actorId
          })) {
            throw new StockServiceError(STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT, `Idempotency key conflicts: ${idempotencyKey}`)
          }
          alreadyApplied += 1
          continue
        }

        const signedQuantity = line.quantity
        productAvailableDelta.set(line.productId, (productAvailableDelta.get(line.productId) ?? 0) + signedQuantity)
        productPhysicalDelta.set(line.productId, (productPhysicalDelta.get(line.productId) ?? 0) + signedQuantity)

        if (targetBucket !== undefined) {
          bucketAvailableDelta.set(targetBucket.bucketId, (bucketAvailableDelta.get(targetBucket.bucketId) ?? 0) + signedQuantity)
          bucketReceivedDelta.set(targetBucket.bucketId, (bucketReceivedDelta.get(targetBucket.bucketId) ?? 0) + signedQuantity)
        }

        planned.push({
          movement: {
            productId: line.productId,
            expiryBucketId: targetBucket?.bucketId,
            type: INVENTORY_MOVEMENT_TYPES.PROJECTION_REPAIR,
            quantity: Math.abs(line.quantity),
            occurredAt,
            sourceType: PURCHASE_SOURCE_TYPE,
            sourceId: input.buyId,
            sourceEvent: PURCHASE_SOURCE_EVENTS.ADJUSTMENT,
            operationId: input.operationId,
            idempotencyKey,
            rulesVersion: this.rulesVersion,
            sourceLineId: movementLineId,
            reason: input.reason.trim(),
            createdBy: input.auth.actorId
          },
          tracked,
          signedQuantity
        })
      }

      for (const [productId, product] of products) {
        const availableQuantity = product.availableQuantity + (productAvailableDelta.get(productId) ?? 0)
        const physicalQuantity = product.physicalQuantity + (productPhysicalDelta.get(productId) ?? 0)
        if (availableQuantity < 0 || physicalQuantity < 0) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_INSUFFICIENT, `Physical stock is insufficient for ${productId}`)
        if (!Number.isSafeInteger(availableQuantity) || !Number.isSafeInteger(physicalQuantity)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Physical stock exceeds safe integer bounds for ${productId}`)
      }

      for (const [bucketId, bucket] of buckets) {
        const availableQuantity = bucket.availableQuantity + (bucketAvailableDelta.get(bucketId) ?? 0)
        const receivedQuantity = bucket.receivedQuantity + (bucketReceivedDelta.get(bucketId) ?? 0)
        if (availableQuantity < 0 || receivedQuantity < 0) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_INSUFFICIENT, `Physical bucket stock is insufficient for ${bucket.productId}`)
        if (!Number.isSafeInteger(availableQuantity) || !Number.isSafeInteger(receivedQuantity)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Physical bucket stock exceeds safe integer bounds for ${bucket.productId}`)
      }

      let applied = 0
      let projections = 0
      for (const entry of planned) {
        const persisted = await this.persistMovement(transaction, entry.movement)
        if (persisted.alreadyApplied) {
          alreadyApplied += 1
          continue
        }
        await this.applyPurchaseAdjustmentProjection(transaction, entry.movement, entry.signedQuantity, entry.tracked)
        applied += 1
        projections += entry.tracked ? 2 : 1
      }
      return operationResult(input.operationId, applied, alreadyApplied, projections)
    })
  }

  async removeExpiredBucket (input: ExpiredRemovalInput): Promise<StockOperationResult> {
    const occurredAt = validateExpiredRemoval(input)
    return await this.runTransaction(input.operationId, async (transaction) => {
      const bucket = await transaction.getBucket(input.bucketId, transaction.session)
      if (bucket === undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_AVAILABILITY_UNAVAILABLE, `Expiry bucket ${input.bucketId} is unavailable`)
      if (!this.validBucketSnapshot(bucket) || bucket.bucketId !== input.bucketId || !isCivilDate(bucket.expiryDate) || bucket.productId.trim() === '') {
        throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Expiry bucket ${input.bucketId} is invalid`)
      }

      const idempotencyKey = `expired-removal:${input.operationId}:${input.bucketId}`
      const existing = await transaction.findMovementByIdempotencyKey(idempotencyKey, transaction.session)
      if (existing !== undefined) {
        const compatible = hasSameMovementSemantics(existing, {
          ...existing,
          productId: bucket.productId,
          expiryBucketId: input.bucketId,
          type: INVENTORY_MOVEMENT_TYPES.EXPIRED_REMOVAL,
          sourceType: EXPIRY_SOURCE_TYPE,
          sourceId: input.bucketId,
          sourceEvent: INVENTORY_MOVEMENT_TYPES.EXPIRED_REMOVAL,
          operationId: input.operationId,
          idempotencyKey,
          rulesVersion: this.rulesVersion,
          reason: input.reason.trim(),
          createdBy: input.auth.actorId
        })
        if (!compatible) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT, `Idempotency key conflicts: ${idempotencyKey}`)
        return operationResult(input.operationId, 0, 1, 0)
      }

      if (bucket.expiryDate >= input.businessDate) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Expiry bucket ${input.bucketId} has not expired`)
      if (bucket.committedQuantity > 0) throw new StockServiceError(STOCK_ERROR_CODES.EXPIRED_BUCKET_HAS_COMMITMENTS, `Expiry bucket ${input.bucketId} has commitments`)
      if (bucket.receivedQuantity !== bucket.availableQuantity) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Expiry bucket ${input.bucketId} is inconsistent`)
      if (bucket.receivedQuantity === 0) return operationResult(input.operationId, 0, 0, 0)

      const product = await transaction.getProduct(bucket.productId, transaction.session)
      if (product === undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_AVAILABILITY_UNAVAILABLE, `Availability is unavailable for ${bucket.productId}`)
      if (!this.validProductSnapshot(product, bucket.productId) || product.physicalQuantity !== product.availableQuantity + product.committedQuantity) {
        throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Product projection is invalid for ${bucket.productId}`)
      }
      if (product.expiryTracking !== EXPIRY_TRACKING.TRACKED) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Expiry bucket data is invalid for ${bucket.productId}`)
      if (product.physicalQuantity < bucket.receivedQuantity || product.availableQuantity < bucket.receivedQuantity) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_INSUFFICIENT, `Physical stock is insufficient for ${bucket.productId}`)

      const movement: StockMovementRecord = {
        productId: bucket.productId,
        expiryBucketId: input.bucketId,
        type: INVENTORY_MOVEMENT_TYPES.EXPIRED_REMOVAL,
        quantity: bucket.receivedQuantity,
        occurredAt,
        sourceType: EXPIRY_SOURCE_TYPE,
        sourceId: input.bucketId,
        sourceEvent: INVENTORY_MOVEMENT_TYPES.EXPIRED_REMOVAL,
        operationId: input.operationId,
        idempotencyKey,
        rulesVersion: this.rulesVersion,
        reason: input.reason.trim(),
        createdBy: input.auth.actorId
      }
      const persisted = await this.persistMovement(transaction, movement)
      if (persisted.alreadyApplied) return operationResult(input.operationId, 0, 1, 0)
      await this.applyExpiredRemovalProjection(transaction, movement)
      return operationResult(input.operationId, 1, 0, 2)
    })
  }

  async deliverSale (input: SaleDeliveryInput): Promise<StockOperationResult> {
    const occurredAt = validateDelivery(input)
    const existingCommitments = await this.repository.findMovements({ sourceType: SOURCE_TYPE, sourceId: input.saleId, type: INVENTORY_MOVEMENT_TYPES.SALE_COMMIT })
    if (existingCommitments.length === 0) return operationResult(input.operationId, 0, 0, 0)
    return await this.runTransaction(input.operationId, async (transaction) => {
      const commitments = await transaction.findMovements({ sourceType: SOURCE_TYPE, sourceId: input.saleId, type: INVENTORY_MOVEMENT_TYPES.SALE_COMMIT }, transaction.session)
      const related = await transaction.findMovements({ sourceType: SOURCE_TYPE, sourceId: input.saleId }, transaction.session)
      const releases = related.filter((movement) => movement.type === INVENTORY_MOVEMENT_TYPES.SALE_ADJUSTMENT && movement.reason === 'release')
      const releaseRemaining = new Map<string, number>()
      for (const release of releases) {
        const releaseKey = `${release.productId}:${release.expiryBucketId ?? 'untracked'}:${release.sourceLineId ?? ''}`
        releaseRemaining.set(releaseKey, (releaseRemaining.get(releaseKey) ?? 0) + release.quantity)
      }
      let applied = 0
      let alreadyApplied = 0
      let projections = 0
      for (const commitment of commitments) {
        if (commitment.movementId === undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Commitment movement identity is missing')
        const key = `sale-delivery:${input.operationId}:${input.saleId}:${commitment.movementId}`
        const existing = await transaction.findMovementByIdempotencyKey(key, transaction.session)
        if (existing !== undefined) {
          const compatible = hasSameMovementSemantics(existing, {
            ...existing,
            productId: commitment.productId,
            expiryBucketId: commitment.expiryBucketId,
            type: INVENTORY_MOVEMENT_TYPES.SALE_DELIVERED_OUT,
            sourceType: SOURCE_TYPE,
            sourceId: input.saleId,
            sourceEvent: DELIVERY_SOURCE_EVENTS.DELIVERED,
            operationId: input.operationId,
            idempotencyKey: key,
            rulesVersion: this.rulesVersion,
            sourceLineId: commitment.sourceLineId,
            reversesMovementId: commitment.movementId,
            createdBy: input.deliveredBy
          })
          if (!compatible) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT, `Idempotency key conflicts: ${key}`)
          alreadyApplied += 1
          continue
        }

        const cancellations = related.filter((movement) => movement.type === INVENTORY_MOVEMENT_TYPES.SALE_CANCEL && movement.reversesMovementId === commitment.movementId)
        const deliveries = related.filter((movement) => movement.type === INVENTORY_MOVEMENT_TYPES.SALE_DELIVERED_OUT && movement.reversesMovementId === commitment.movementId)
        const cancelledQuantity = cancellations.reduce((total, movement) => total + movement.quantity, 0)
        const deliveredQuantity = deliveries.reduce((total, movement) => total + movement.quantity, 0)
        const releaseKey = `${commitment.productId}:${commitment.expiryBucketId ?? 'untracked'}:${commitment.sourceLineId ?? ''}`
        const releaseQuantity = Math.min(releaseRemaining.get(releaseKey) ?? 0, Math.max(0, commitment.quantity - cancelledQuantity - deliveredQuantity))
        releaseRemaining.set(releaseKey, Math.max(0, (releaseRemaining.get(releaseKey) ?? 0) - releaseQuantity))
        const consumedQuantity = cancelledQuantity + deliveredQuantity + releaseQuantity
        if (consumedQuantity > commitment.quantity) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Commitment compensations exceed ${commitment.movementId}`)
        const quantity = commitment.quantity - consumedQuantity
        if (quantity === 0) continue

        const product = await transaction.getProduct(commitment.productId, transaction.session)
        if (product === undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_AVAILABILITY_UNAVAILABLE, `Availability is unavailable for ${commitment.productId}`)
        if (!this.validProductSnapshot(product, commitment.productId)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Product projection is invalid for ${commitment.productId}`)
        const buckets = await transaction.getBuckets(commitment.productId, transaction.session)
        if (product.expiryTracking === EXPIRY_TRACKING.TRACKED) {
          if (commitment.expiryBucketId === undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Delivery bucket is required for ${commitment.productId}`)
          const bucket = buckets.find((entry) => entry.bucketId === commitment.expiryBucketId)
          if (bucket === undefined || !this.validBucketSnapshot(bucket) || bucket.productId !== commitment.productId || bucket.committedQuantity < quantity || bucket.receivedQuantity < quantity || bucket.receivedQuantity !== bucket.availableQuantity + bucket.committedQuantity) {
            throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Physical bucket projection is invalid for ${commitment.productId}`)
          }
          if (product.physicalQuantity < quantity || product.committedQuantity < quantity) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_INSUFFICIENT, `Physical stock is insufficient for ${commitment.productId}`)
        } else if (product.expiryTracking === EXPIRY_TRACKING.NOT_TRACKED) {
          if (commitment.expiryBucketId !== undefined || buckets.length > 0) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Delivery bucket data is invalid for ${commitment.productId}`)
          if (product.physicalQuantity < quantity || product.committedQuantity < quantity) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_INSUFFICIENT, `Physical stock is insufficient for ${commitment.productId}`)
        } else {
          throw new StockServiceError(STOCK_ERROR_CODES.STOCK_AVAILABILITY_UNAVAILABLE, `Expiry tracking is unavailable for ${commitment.productId}`)
        }

        const movement: StockMovementRecord = {
          productId: commitment.productId,
          expiryBucketId: commitment.expiryBucketId,
          type: INVENTORY_MOVEMENT_TYPES.SALE_DELIVERED_OUT,
          quantity,
          occurredAt,
          sourceType: SOURCE_TYPE,
          sourceId: input.saleId,
          sourceEvent: DELIVERY_SOURCE_EVENTS.DELIVERED,
          operationId: input.operationId,
          idempotencyKey: key,
          rulesVersion: this.rulesVersion,
          sourceLineId: commitment.sourceLineId,
          reversesMovementId: commitment.movementId,
          createdBy: input.deliveredBy
        }
        const persisted = await this.persistMovement(transaction, movement)
        if (persisted.alreadyApplied) {
          alreadyApplied += 1
          continue
        }
        await this.applyDeliveryProjection(transaction, movement)
        applied += 1
        projections += commitment.expiryBucketId === undefined ? 1 : 2
      }
      return operationResult(input.operationId, applied, alreadyApplied, projections)
    })
  }

  async returnSale (input: StockPhysicalReturnInput): Promise<StockOperationResult> {
    const occurredAt = validatePhysicalReturn(input)
    return await this.runTransaction(input.operationId, async (transaction) => {
      const delivered = await transaction.findMovements({ sourceType: SOURCE_TYPE, sourceId: input.saleId, type: INVENTORY_MOVEMENT_TYPES.SALE_DELIVERED_OUT }, transaction.session)
      if (delivered.length === 0) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_INSUFFICIENT, `Sale ${input.saleId} has not been delivered`)

      const existingReturns = await transaction.findMovements({ sourceType: SOURCE_TYPE, sourceId: input.saleId, type: INVENTORY_MOVEMENT_TYPES.RETURN_IN }, transaction.session)
      const deliveredById = new Map<string, StockMovementRecord>()
      for (const movement of delivered) {
        if (movement.movementId === undefined || !validIdentity(movement.productId) || !isPositiveInteger(movement.quantity)) {
          throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Delivered sale movement is incomplete')
        }
        if (deliveredById.has(movement.movementId)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Delivered sale movement identity is duplicated')
        deliveredById.set(movement.movementId, movement)
      }

      const returnedByDelivery = new Map<string, number>()
      for (const movement of existingReturns) {
        if (movement.movementId === undefined || movement.reversesMovementId === undefined || !isPositiveInteger(movement.quantity)) {
          throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Physical return movement is incomplete')
        }
        const original = deliveredById.get(movement.reversesMovementId)
        if (original === undefined || movement.productId !== original.productId || movement.expiryBucketId !== original.expiryBucketId) {
          throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Physical return does not reference a delivered sale allocation')
        }
        const returned = (returnedByDelivery.get(movement.reversesMovementId) ?? 0) + movement.quantity
        if (returned > original.quantity) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Physical returns exceed a delivered allocation')
        returnedByDelivery.set(movement.reversesMovementId, returned)
      }

      const products = new Map<string, StockProductSnapshot>()
      const bucketsByProduct = new Map<string, StockBucketSnapshot[]>()
      for (const productId of new Set(input.lines.map((line) => line.productId))) {
        const product = await transaction.getProduct(productId, transaction.session)
        if (product === undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_INSUFFICIENT, `Product ${productId} is not owned by sale ${input.saleId}`)
        if (!this.validProductSnapshot(product, productId)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Product projection is invalid for ${productId}`)
        const buckets = await transaction.getBuckets(productId, transaction.session)
        if (!buckets.every(this.validBucketSnapshot) || buckets.some((bucket) => bucket.productId !== productId || bucket.receivedQuantity !== bucket.availableQuantity + bucket.committedQuantity)) {
          throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Physical bucket projection is invalid for ${productId}`)
        }
        if (product.expiryTracking === EXPIRY_TRACKING.UNKNOWN) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_AVAILABILITY_UNAVAILABLE, `Expiry tracking is unavailable for ${productId}`)
        if (product.expiryTracking === EXPIRY_TRACKING.NOT_TRACKED && buckets.length > 0) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Bucket data is invalid for ${productId}`)
        products.set(productId, product)
        bucketsByProduct.set(productId, buckets)
      }

      for (const movement of delivered) {
        const product = products.get(movement.productId)
        if (product === undefined) continue
        const buckets = bucketsByProduct.get(movement.productId) ?? []
        if (product.expiryTracking === EXPIRY_TRACKING.TRACKED) {
          if (movement.expiryBucketId === undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Delivered bucket is missing for ${movement.productId}`)
          const bucket = buckets.find((entry) => entry.bucketId === movement.expiryBucketId)
          if (bucket === undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Delivered bucket is unavailable for ${movement.productId}`)
        } else if (movement.expiryBucketId !== undefined) {
          throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Delivered bucket data is invalid for ${movement.productId}`)
        }
      }

      const remainingByDelivery = new Map<string, number>()
      for (const movement of delivered) {
        const currentOperationReturned = existingReturns
          .filter((candidate) => candidate.reversesMovementId === movement.movementId && candidate.operationId === input.operationId)
          .reduce((total, candidate) => total + candidate.quantity, 0)
        remainingByDelivery.set(movement.movementId as string, movement.quantity - (returnedByDelivery.get(movement.movementId as string) ?? 0) + currentOperationReturned)
      }

      const compareDeliveries = (left: StockMovementRecord, right: StockMovementRecord): number => {
        const product = products.get(left.productId)
        if (product?.expiryTracking === EXPIRY_TRACKING.TRACKED) {
          const buckets = bucketsByProduct.get(left.productId) ?? []
          const leftBucket = buckets.find((bucket) => bucket.bucketId === left.expiryBucketId)
          const rightBucket = buckets.find((bucket) => bucket.bucketId === right.expiryBucketId)
          const expiryComparison = (leftBucket?.expiryDate ?? '').localeCompare(rightBucket?.expiryDate ?? '')
          if (expiryComparison !== 0) return expiryComparison
        }
        return (left.movementId as string).localeCompare(right.movementId as string)
      }

      const currentOperationReturns = existingReturns.filter((movement) => movement.operationId === input.operationId)
      const currentOperationByKey = new Map(currentOperationReturns.map((movement) => [movement.idempotencyKey, movement]))
      const expectedCurrentKeys = new Set<string>()
      const planned: Array<{ movement: StockMovementRecord, alreadyApplied: boolean, tracked: boolean }> = []

      input.lines.forEach((line: StockPhysicalReturnLineInput, lineIndex: number) => {
        const candidates = delivered
          .filter((movement) => movement.productId === line.productId && (line.lineId === undefined || movement.sourceLineId === line.lineId))
          .sort(compareDeliveries)
        if (candidates.length === 0) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_INSUFFICIENT, `Product or line is not owned by sale ${input.saleId}`)
        const available = candidates.reduce((total, movement) => total + (remainingByDelivery.get(movement.movementId as string) ?? 0), 0)
        if (available < line.quantity) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_INSUFFICIENT, `Physical return exceeds delivered quantity for ${line.productId}`)

        let pending = line.quantity
        const returnLineId = line.lineId ?? `line-${lineIndex}`
        for (const delivery of candidates) {
          if (pending === 0) break
          const deliveryId = delivery.movementId as string
          const quantity = Math.min(pending, remainingByDelivery.get(deliveryId) ?? 0)
          if (quantity === 0) continue
          const idempotencyKey = `sale-return:${input.operationId}:${input.saleId}:${returnLineId}:${deliveryId}`
          expectedCurrentKeys.add(idempotencyKey)
          const movement: StockMovementRecord = {
            productId: delivery.productId,
            expiryBucketId: delivery.expiryBucketId,
            type: INVENTORY_MOVEMENT_TYPES.RETURN_IN,
            quantity,
            occurredAt,
            sourceType: SOURCE_TYPE,
            sourceId: input.saleId,
            sourceEvent: RETURN_SOURCE_EVENTS.RETURN,
            operationId: input.operationId,
            idempotencyKey,
            rulesVersion: this.rulesVersion,
            sourceLineId: delivery.sourceLineId,
            reversesMovementId: deliveryId,
            createdBy: input.auth.actorId
          }
          const existing = currentOperationByKey.get(idempotencyKey)
          if (existing !== undefined && !hasSameMovementSemantics(existing, movement)) {
            throw new StockServiceError(STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT, `Idempotency key conflicts: ${idempotencyKey}`)
          }
          planned.push({ movement, alreadyApplied: existing !== undefined, tracked: products.get(delivery.productId)?.expiryTracking === EXPIRY_TRACKING.TRACKED })
          remainingByDelivery.set(deliveryId, (remainingByDelivery.get(deliveryId) ?? 0) - quantity)
          pending -= quantity
        }
      })

      if (currentOperationReturns.some((movement) => !expectedCurrentKeys.has(movement.idempotencyKey))) {
        throw new StockServiceError(STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT, `Idempotency key conflicts for operation ${input.operationId}`)
      }

      let applied = 0
      let alreadyApplied = 0
      let projections = 0
      for (const entry of planned) {
        const persisted = await this.persistMovement(transaction, entry.movement)
        if (persisted.alreadyApplied || entry.alreadyApplied) {
          alreadyApplied += 1
          continue
        }
        await this.applyReturnProjection(transaction, entry.movement, entry.tracked)
        applied += 1
        projections += entry.tracked ? 2 : 1
      }
      return operationResult(input.operationId, applied, alreadyApplied, projections)
    })
  }

  async cancelSale (input: StockSaleCancelInput): Promise<StockOperationResult> {
    validateOperation(input)
    return await this.runTransaction(input.operationId, async (transaction) => {
      const commitments = await transaction.findMovements({ sourceType: SOURCE_TYPE, sourceId: input.saleId, type: INVENTORY_MOVEMENT_TYPES.SALE_COMMIT }, transaction.session)
      if (commitments.length === 0) return operationResult(input.operationId, 0, 0, 0)
      let applied = 0
      let alreadyApplied = 0
      let projections = 0
      for (const commitment of commitments) {
        if (commitment.movementId === undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Commitment movement identity is missing')
        const key = `sale-cancel:${input.saleId}:${commitment.movementId}`
        const movement: StockMovementRecord = {
          productId: commitment.productId,
          expiryBucketId: commitment.expiryBucketId,
          type: INVENTORY_MOVEMENT_TYPES.SALE_CANCEL,
          quantity: commitment.quantity,
          occurredAt: input.occurredAt ?? new Date(),
          sourceType: SOURCE_TYPE,
          sourceId: input.saleId,
          sourceEvent: SOURCE_EVENTS.CANCEL,
          operationId: input.operationId,
          idempotencyKey: key,
          rulesVersion: this.rulesVersion,
          sourceLineId: commitment.sourceLineId,
          reversesMovementId: commitment.movementId,
          createdBy: input.auth.actorId
        }
        const result = await this.persistMovement(transaction, movement)
        if (result.alreadyApplied) {
          alreadyApplied += 1
          continue
        }
        await this.applyProjectionDelta(transaction, movement, -1)
        applied += 1
        projections += commitment.expiryBucketId === undefined ? 1 : 2
      }
      return operationResult(input.operationId, applied, alreadyApplied, projections)
    })
  }

  async adjustSale (input: StockSaleAdjustmentInput): Promise<StockOperationResult> {
    validateOperation(input)
    const additions = input.additions ?? []
    const releases = input.releases ?? []
    if (additions.length === 0 && releases.length === 0) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Adjustment must explicitly contain additions or releases')
    if (additions.length > 0) aggregateLines(additions)
    for (const release of releases) this.validateRelease(release)

    return await this.runTransaction(input.operationId, async (transaction) => {
      let applied = 0
      let alreadyApplied = 0
      let projections = 0
      if (additions.length > 0) {
        const previousAdditions = await transaction.findMovements({ sourceType: SOURCE_TYPE, sourceId: input.saleId, type: INVENTORY_MOVEMENT_TYPES.SALE_ADJUSTMENT }, transaction.session)
        const pendingAdditions: StockSaleLineInput[] = []
        for (const addition of additions) {
          const previousForLine = previousAdditions.filter((movement) => movement.sourceLineId === addition.lineId && movement.reason === 'addition')
          const retryMovements = previousForLine.filter((movement) => movement.operationId === input.operationId)
          if (retryMovements.length > 0) {
            if (!compatibleRetryBatch(retryMovements, input, addition, INVENTORY_MOVEMENT_TYPES.SALE_ADJUSTMENT, SOURCE_EVENTS.ADJUSTMENT, this.rulesVersion, 'addition')) {
              throw new StockServiceError(STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT, `Existing adjustment conflicts for line ${addition.lineId}`)
            }
            alreadyApplied += retryMovements.length
          } else {
            pendingAdditions.push(addition)
          }
        }
        if (pendingAdditions.length > 0) {
          await this.assertAvailabilityInTransaction(transaction, pendingAdditions, input.businessDate, input.timeZone ?? this.timeZone)
          const additionCounters = await this.applyAdditions(transaction, input, pendingAdditions, INVENTORY_MOVEMENT_TYPES.SALE_ADJUSTMENT, SOURCE_EVENTS.ADJUSTMENT, 'addition')
          applied += additionCounters.applied
          alreadyApplied += additionCounters.alreadyApplied
          projections += additionCounters.projections
        }
      }
      for (const release of releases) {
        const key = `sale-adjustment-release:${input.operationId}:${input.saleId}:${release.lineId}:${release.bucketId ?? 'untracked'}`
        const movement: StockMovementRecord = {
          productId: release.productId,
          expiryBucketId: release.bucketId,
          type: INVENTORY_MOVEMENT_TYPES.SALE_ADJUSTMENT,
          quantity: release.quantity,
          occurredAt: input.occurredAt ?? new Date(),
          sourceType: SOURCE_TYPE,
          sourceId: input.saleId,
          sourceEvent: SOURCE_EVENTS.ADJUSTMENT,
          operationId: input.operationId,
          idempotencyKey: key,
          rulesVersion: this.rulesVersion,
          sourceLineId: release.lineId,
          reason: 'release',
          createdBy: input.auth.actorId
        }
        const existing = await transaction.findMovementByIdempotencyKey(key, transaction.session)
        if (existing !== undefined) {
          if (!hasSameMovementSemantics(existing, movement)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT, `Idempotency key conflicts: ${key}`)
          alreadyApplied += 1
          continue
        }
        const product = await transaction.getProduct(release.productId, transaction.session)
        if (product === undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_AVAILABILITY_UNAVAILABLE, `Availability is unavailable for ${release.productId}`)
        const buckets = await transaction.getBuckets(release.productId, transaction.session)
        if (product.expiryTracking === EXPIRY_TRACKING.TRACKED) {
          if (release.bucketId === undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Release bucket is required for ${release.productId}`)
          const target = buckets.find((bucket) => bucket.bucketId === release.bucketId)
          if (target === undefined || target.committedQuantity < release.quantity) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_INSUFFICIENT, `Committed stock is insufficient for ${release.productId}`)
        } else if (release.bucketId !== undefined || buckets.length > 0) {
          throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Release bucket data is invalid for ${release.productId}`)
        }
        const commitments = await transaction.findMovements({ sourceType: SOURCE_TYPE, sourceId: input.saleId, type: INVENTORY_MOVEMENT_TYPES.SALE_COMMIT }, transaction.session)
        const cancellations = await transaction.findMovements({ sourceType: SOURCE_TYPE, sourceId: input.saleId, type: INVENTORY_MOVEMENT_TYPES.SALE_CANCEL }, transaction.session)
        const priorReleases = await transaction.findMovements({ sourceType: SOURCE_TYPE, sourceId: input.saleId, type: INVENTORY_MOVEMENT_TYPES.SALE_ADJUSTMENT }, transaction.session)
        const matchesRelease = (candidate: StockMovementRecord): boolean => candidate.productId === release.productId && candidate.expiryBucketId === release.bucketId && candidate.sourceLineId === release.lineId
        const ownedQuantity = commitments.filter(matchesRelease).reduce((total, movement) => total + movement.quantity, 0) -
          cancellations.filter(matchesRelease).reduce((total, movement) => total + movement.quantity, 0) -
          priorReleases.filter((movement) => movement.reason === 'release' && matchesRelease(movement)).reduce((total, movement) => total + movement.quantity, 0)
        if (ownedQuantity < release.quantity) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_INSUFFICIENT, `Committed stock is insufficient for sale ${input.saleId}`)
        const persisted = await this.persistMovement(transaction, movement)
        if (persisted.alreadyApplied) {
          alreadyApplied += 1
        } else {
          await this.applyProjectionDelta(transaction, movement, -1)
          applied += 1
          projections += release.bucketId === undefined ? 1 : 2
        }
      }
      return operationResult(input.operationId, applied, alreadyApplied, projections)
    })
  }

  private async readAvailability (repository: StockRepository, productId: string, businessDate: string, timeZone: string, session?: StockTransactionContext['session']): Promise<AvailabilityResult> {
    try {
      const product = await repository.getProduct(productId, session)
      if (product === undefined) return incompleteAvailability(productId)
      const buckets = await repository.getBuckets(productId, session)
      if (!this.validProductSnapshot(product, productId) || !Array.isArray(buckets) || !buckets.every(this.validBucketSnapshot) || buckets.some((bucket) => bucket.productId !== productId || bucket.receivedQuantity !== bucket.availableQuantity + bucket.committedQuantity)) return incompleteAvailability(productId)
      if (product.expiryTracking === EXPIRY_TRACKING.NOT_TRACKED && buckets.length > 0) return incompleteAvailability(productId)
      return calculateAvailability({
        productId,
        businessDate,
        timeZone,
        physicalQuantity: product.physicalQuantity,
        committedQuantity: product.committedQuantity,
        expiryTracking: product.expiryTracking,
        baselineStatus: product.baselineStatus,
        expiryBuckets: product.expiryTracking === EXPIRY_TRACKING.TRACKED
          ? buckets.map((entry) => ({
            bucketId: entry.bucketId,
            expiryDate: entry.expiryDate,
            availableQuantity: entry.availableQuantity,
            committedQuantity: entry.committedQuantity
          }))
          : undefined
      })
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR, errorMessage(error))
    }
  }

  private alertsFor (productId: string, availability: AvailabilityResult, minimum: number | null, buckets: StockBucketSnapshot[], businessDate: string, timeZone: string, history?: StockRotationInput, expiryAlertDays: number = STOCK_EXPIRY_ALERT_DAYS): StockAlert[] {
    const alerts: StockAlert[] = []
    const rotation = history === undefined
      ? undefined
      : evaluateLowRotation(history)
    if (rotation?.alert !== undefined) alerts.push(rotation.alert)
    if (rotation?.dataQuality === STOCK_DATA_QUALITY.INSUFFICIENT_HISTORY) {
      alerts.push({
        type: STOCK_ALERT_TYPES.LOW_ROTATION,
        severity: STOCK_ALERT_SEVERITIES.INFO,
        productId,
        explanation: `Product ${productId} has insufficient history for the last ${STOCK_ROTATION_DAYS} complete calendar days`,
        dataQuality: STOCK_DATA_QUALITY.INSUFFICIENT_HISTORY
      })
    }
    if (availability.dataQuality === STOCK_DATA_QUALITY.COMPLETE) {
      const product = availability
      const lowStock = evaluateLowStock({ ...product, minimum: minimum ?? undefined })
      if (lowStock !== undefined) alerts.push(lowStock)
      // Expiry rules are applicable only when availability is trustworthy and bucket data is tracked.
      if (buckets.length > 0) {
        alerts.push(...evaluateExpiry({
          productId,
          businessDate,
          timeZone,
          alertDays: expiryAlertDays,
          buckets: buckets.map((bucket) => ({
            bucketId: bucket.bucketId,
            expiryDate: bucket.expiryDate,
            availableQuantity: bucket.availableQuantity,
            committedQuantity: bucket.committedQuantity
          }))
        }))
      }
      return alerts
    }
    const lowStock = evaluateLowStock({ ...availability, minimum: minimum ?? undefined })
    if (lowStock !== undefined) alerts.push(lowStock)
    return alerts
  }

  private async assertAvailabilityInTransaction (repository: StockRepository & StockTransactionContext, lines: StockSaleLineInput[], businessDate: string, timeZone: string): Promise<void> {
    const aggregated = aggregateLines(lines)
    const results = await Promise.all(aggregated.map(async ({ productId }) => await this.readAvailability(repository, productId, businessDate, timeZone, repository.session)))
    for (const result of results) {
      if (result.dataQuality !== STOCK_DATA_QUALITY.COMPLETE) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_AVAILABILITY_UNAVAILABLE, `Availability is unavailable for ${result.productId}`)
      const requested = aggregated.find((line) => line.productId === result.productId)?.quantity ?? 0
      if (requested > result.availableToSell) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_INSUFFICIENT, `Insufficient stock for ${result.productId}: requested ${requested}, available ${result.availableToSell}`)
    }
  }

  private async applyAdditions (transaction: StockRepository & StockTransactionContext, input: StockOperationInput & { occurredAt?: Date }, lines: StockSaleLineInput[], movementType: typeof INVENTORY_MOVEMENT_TYPES.SALE_COMMIT | typeof INVENTORY_MOVEMENT_TYPES.SALE_ADJUSTMENT, sourceEvent: StockSourceEvent, reason?: string): Promise<{ applied: number, alreadyApplied: number, projections: number }> {
    let applied = 0
    let alreadyApplied = 0
    let projections = 0
    for (const line of lines) {
      const product = await transaction.getProduct(line.productId, transaction.session)
      if (product === undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_AVAILABILITY_UNAVAILABLE, `Availability is unavailable for ${line.productId}`)
      let allocations: FefoAllocationResult['allocations'] = []
      if (product.expiryTracking === EXPIRY_TRACKING.TRACKED) {
        const buckets = await transaction.getBuckets(line.productId, transaction.session)
        try {
          allocations = allocateFefo({
            productId: line.productId,
            businessDate: input.businessDate,
            timeZone: input.timeZone ?? this.timeZone,
            requestedQuantity: line.quantity,
            buckets: buckets.filter((bucket) => bucket.expiryDate >= input.businessDate).map((bucket) => ({
              bucketId: bucket.bucketId,
              expiryDate: bucket.expiryDate,
              availableQuantity: bucket.availableQuantity,
              committedQuantity: bucket.committedQuantity
            }))
          }).allocations
        } catch (error) {
          if (error instanceof StockRuleError) throw new StockServiceError(error.code, error.message)
          throw error
        }
      } else if (product.expiryTracking !== EXPIRY_TRACKING.NOT_TRACKED) {
        throw new StockServiceError(STOCK_ERROR_CODES.STOCK_AVAILABILITY_UNAVAILABLE, `Expiry tracking is unavailable for ${line.productId}`)
      }
      if (allocations.length === 0) allocations = [{ bucketId: '', expiryDate: '', quantity: line.quantity }]
      for (const allocation of allocations) {
        const bucketId = allocation.bucketId === '' ? undefined : allocation.bucketId
        const keyPrefix = movementType === INVENTORY_MOVEMENT_TYPES.SALE_COMMIT ? 'sale-commit' : 'sale-adjustment-add'
        const movement: StockMovementRecord = {
          productId: line.productId,
          expiryBucketId: bucketId,
          type: movementType,
          quantity: allocation.quantity,
          occurredAt: input.occurredAt ?? new Date(),
          sourceType: SOURCE_TYPE,
          sourceId: input.saleId,
          sourceEvent,
          operationId: input.operationId,
          idempotencyKey: `${keyPrefix}:${input.operationId}:${input.saleId}:${line.lineId}:${bucketId ?? 'untracked'}`,
          rulesVersion: this.rulesVersion,
          sourceLineId: line.lineId,
          reason,
          createdBy: input.auth.actorId
        }
        const persisted = await this.persistMovement(transaction, movement)
        if (persisted.alreadyApplied) {
          alreadyApplied += 1
          continue
        }
        await this.applyProjectionDelta(transaction, movement, 1)
        applied += 1
        projections += bucketId === undefined ? 1 : 2
      }
    }
    return { applied, alreadyApplied, projections }
  }

  private async persistMovement (transaction: StockRepository & StockTransactionContext, movement: StockMovementRecord): Promise<StockIdempotentMovementResult> {
    const existing = await transaction.findMovementByIdempotencyKey(movement.idempotencyKey, transaction.session)
    if (existing !== undefined) {
      if (!hasSameMovementSemantics(existing, movement)) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT, `Idempotency key conflicts: ${movement.idempotencyKey}`)
      return { movement: existing, alreadyApplied: true }
    }
    try {
      const inserted = await transaction.insertMovement(movement, transaction.session)
      return { movement: inserted, alreadyApplied: false }
    } catch (error) {
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR, errorMessage(error))
    }
  }

  private async applyProjectionDelta (transaction: StockRepository & StockTransactionContext, movement: StockMovementRecord, direction: 1 | -1): Promise<void> {
    try {
      const quantity = movement.quantity * direction
      await transaction.applyProductProjectionDelta(movement.productId, {
        availableQuantityDelta: -quantity,
        committedQuantityDelta: quantity,
        physicalQuantityDelta: 0
      }, transaction.session)
      if (movement.expiryBucketId !== undefined) {
        await transaction.applyBucketProjectionDelta(movement.expiryBucketId, {
          availableQuantityDelta: -quantity,
          committedQuantityDelta: quantity
        }, transaction.session)
      }
    } catch (error) {
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR, errorMessage(error))
    }
  }

  private async applyPhysicalProjection (transaction: StockRepository & StockTransactionContext, movement: StockMovementRecord): Promise<void> {
    try {
      await transaction.applyProductProjectionDelta(movement.productId, {
        availableQuantityDelta: movement.quantity,
        committedQuantityDelta: 0,
        physicalQuantityDelta: movement.quantity
      }, transaction.session)
    } catch (error) {
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR, errorMessage(error))
    }
  }

  private async applyPurchaseAdjustmentProjection (transaction: StockRepository & StockTransactionContext, movement: StockMovementRecord, signedQuantity: number, tracked: boolean): Promise<void> {
    try {
      await transaction.applyProductProjectionDelta(movement.productId, {
        availableQuantityDelta: signedQuantity,
        committedQuantityDelta: 0,
        physicalQuantityDelta: signedQuantity
      }, transaction.session)
      if (tracked) {
        if (movement.expiryBucketId === undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Adjustment bucket is missing for ${movement.productId}`)
        await transaction.applyBucketProjectionDelta(movement.expiryBucketId, {
          availableQuantityDelta: signedQuantity,
          committedQuantityDelta: 0,
          receivedQuantityDelta: signedQuantity
        }, transaction.session)
      }
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR, errorMessage(error))
    }
  }

  private async applyExpiredRemovalProjection (transaction: StockRepository & StockTransactionContext, movement: StockMovementRecord): Promise<void> {
    try {
      await transaction.applyProductProjectionDelta(movement.productId, {
        availableQuantityDelta: -movement.quantity,
        committedQuantityDelta: 0,
        physicalQuantityDelta: -movement.quantity
      }, transaction.session)
      if (movement.expiryBucketId === undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Expired removal bucket is missing for ${movement.productId}`)
      await transaction.applyBucketProjectionDelta(movement.expiryBucketId, {
        availableQuantityDelta: -movement.quantity,
        committedQuantityDelta: 0,
        receivedQuantityDelta: -movement.quantity
      }, transaction.session)
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR, errorMessage(error))
    }
  }

  private async applyStockWriteOffProjection (transaction: StockRepository & StockTransactionContext, movement: StockMovementRecord): Promise<void> {
    try {
      await transaction.applyProductProjectionDelta(movement.productId, {
        availableQuantityDelta: -movement.quantity,
        committedQuantityDelta: 0,
        physicalQuantityDelta: -movement.quantity
      }, transaction.session)
      if (movement.expiryBucketId !== undefined) {
        await transaction.applyBucketProjectionDelta(movement.expiryBucketId, {
          availableQuantityDelta: -movement.quantity,
          committedQuantityDelta: 0,
          receivedQuantityDelta: -movement.quantity
        }, transaction.session)
      }
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR, errorMessage(error))
    }
  }

  private async applyDeliveryProjection (transaction: StockRepository & StockTransactionContext, movement: StockMovementRecord): Promise<void> {
    try {
      await transaction.applyProductProjectionDelta(movement.productId, {
        availableQuantityDelta: 0,
        committedQuantityDelta: -movement.quantity,
        physicalQuantityDelta: -movement.quantity
      }, transaction.session)
      if (movement.expiryBucketId !== undefined) {
        await transaction.applyBucketProjectionDelta(movement.expiryBucketId, {
          availableQuantityDelta: 0,
          committedQuantityDelta: -movement.quantity,
          receivedQuantityDelta: -movement.quantity
        }, transaction.session)
      }
    } catch (error) {
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR, errorMessage(error))
    }
  }

  private async applyReturnProjection (transaction: StockRepository & StockTransactionContext, movement: StockMovementRecord, tracked: boolean): Promise<void> {
    try {
      await transaction.applyProductProjectionDelta(movement.productId, {
        availableQuantityDelta: movement.quantity,
        committedQuantityDelta: 0,
        physicalQuantityDelta: movement.quantity
      }, transaction.session)
      if (tracked) {
        if (movement.expiryBucketId === undefined) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Return bucket is missing for ${movement.productId}`)
        await transaction.applyBucketProjectionDelta(movement.expiryBucketId, {
          availableQuantityDelta: movement.quantity,
          committedQuantityDelta: 0,
          receivedQuantityDelta: movement.quantity
        }, transaction.session)
      }
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR, errorMessage(error))
    }
  }

  private validateRelease (release: StockSaleReleaseInput): void {
    if (typeof release.lineId !== 'string' || release.lineId.trim() === '' || typeof release.productId !== 'string' || release.productId.trim() === '' || !isPositiveInteger(release.quantity) || (release.bucketId !== undefined && release.bucketId.trim() === '')) {
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Release lines are incomplete')
    }
  }

  private validProductSnapshot (product: StockProductSnapshot, expectedProductId: string): boolean {
    return product.productId === expectedProductId &&
      [product.physicalQuantity, product.committedQuantity, product.availableQuantity].every((value) => Number.isSafeInteger(value) && value >= 0) &&
      Object.values(EXPIRY_TRACKING).includes(product.expiryTracking) && Object.values(BASELINE_STATUS).includes(product.baselineStatus)
  }

  private validBucketSnapshot (bucket: StockBucketSnapshot): boolean {
    return typeof bucket.bucketId === 'string' && bucket.bucketId !== '' && typeof bucket.productId === 'string' && bucket.productId !== '' &&
      /^\d{4}-\d{2}-\d{2}$/.test(bucket.expiryDate) &&
      [bucket.receivedQuantity, bucket.availableQuantity, bucket.committedQuantity].every((value) => Number.isSafeInteger(value) && value >= 0)
  }

  private async runTransaction<T> (operationId: string, work: (transaction: StockRepository & StockTransactionContext) => Promise<T>): Promise<T> {
    try {
      return await this.repository.withTransaction(work)
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR, `Operation ${operationId} failed: ${errorMessage(error)}`)
    }
  }
}

export const createStockService = (repository: StockRepository, options?: StockServiceOptions): StockService => new StockService(repository, options)
