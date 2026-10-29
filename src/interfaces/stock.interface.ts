import type { Types } from 'mongoose'

export const INVENTORY_MOVEMENT_TYPES = {
  OPENING: 'OPENING',
  PURCHASE_IN: 'PURCHASE_IN',
  SALE_COMMIT: 'SALE_COMMIT',
  SALE_ADJUSTMENT: 'SALE_ADJUSTMENT',
  SALE_CANCEL: 'SALE_CANCEL',
  SALE_DELIVERED_OUT: 'SALE_DELIVERED_OUT',
  RETURN_IN: 'RETURN_IN',
  EXPIRED_REMOVAL: 'EXPIRED_REMOVAL',
  PROJECTION_REPAIR: 'PROJECTION_REPAIR'
} as const

export type InventoryMovementType = (typeof INVENTORY_MOVEMENT_TYPES)[keyof typeof INVENTORY_MOVEMENT_TYPES]

export interface InventoryMovement {
  productId: Types.ObjectId
  expiryBucketId?: Types.ObjectId
  type: InventoryMovementType
  quantity: number
  occurredAt: Date
  sourceType: string
  sourceId: string
  sourceEvent: string
  operationId: string
  idempotencyKey: string
  rulesVersion: string
  sourceLineId?: Types.ObjectId
  reason?: string
  reversesMovementId?: Types.ObjectId
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

export interface StockExpiryBucket {
  productId: Types.ObjectId
  expiryDate: Date
  receivedQuantity: number
  availableQuantity: number
  committedQuantity: number
  createdAt: Date
  updatedAt: Date
}

export const STOCK_ERROR_CODES = {
  STOCK_INSUFFICIENT: 'STOCK_INSUFFICIENT',
  STOCK_AVAILABILITY_UNAVAILABLE: 'STOCK_AVAILABILITY_UNAVAILABLE',
  STOCK_DATA_INCOMPLETE: 'STOCK_DATA_INCOMPLETE',
  STOCK_FORBIDDEN: 'STOCK_FORBIDDEN',
  STOCK_PRODUCT_NOT_FOUND: 'STOCK_PRODUCT_NOT_FOUND',
  EXPIRED_BUCKET_HAS_COMMITMENTS: 'EXPIRED_BUCKET_HAS_COMMITMENTS',
  STOCK_BASELINE_ALREADY_RECONCILED: 'STOCK_BASELINE_ALREADY_RECONCILED',
  STOCK_BUCKET_HAS_COMMITMENTS: 'STOCK_BUCKET_HAS_COMMITMENTS',
  STOCK_IDEMPOTENCY_CONFLICT: 'STOCK_IDEMPOTENCY_CONFLICT',
  STOCK_REPOSITORY_ERROR: 'STOCK_REPOSITORY_ERROR'
} as const

export type StockErrorCode = (typeof STOCK_ERROR_CODES)[keyof typeof STOCK_ERROR_CODES]

export const STOCK_OPERATION_STATUSES = {
  PENDING: 'PENDING',
  APPLIED: 'APPLIED',
  IDEMPOTENT_RETRY: 'IDEMPOTENT_RETRY',
  FAILED_RECOVERABLE: 'FAILED_RECOVERABLE'
} as const

export type StockOperationStatus = (typeof STOCK_OPERATION_STATUSES)[keyof typeof STOCK_OPERATION_STATUSES]

export const STOCK_DATA_QUALITY = {
  COMPLETE: 'COMPLETE',
  INCOMPLETE: 'INCOMPLETE',
  INSUFFICIENT_HISTORY: 'INSUFFICIENT_HISTORY'
} as const

export type StockDataQuality = (typeof STOCK_DATA_QUALITY)[keyof typeof STOCK_DATA_QUALITY]

export const EXPIRY_TRACKING = {
  TRACKED: 'TRACKED',
  NOT_TRACKED: 'NOT_TRACKED',
  UNKNOWN: 'UNKNOWN'
} as const

export type ExpiryTracking = (typeof EXPIRY_TRACKING)[keyof typeof EXPIRY_TRACKING]

export const BASELINE_STATUS = {
  UNVERIFIED: 'UNVERIFIED',
  RECONCILED: 'RECONCILED'
} as const

export type BaselineStatus = (typeof BASELINE_STATUS)[keyof typeof BASELINE_STATUS]

export const STOCK_ALERT_TYPES = {
  LOW_STOCK: 'LOW_STOCK',
  CRITICAL_STOCK: 'CRITICAL_STOCK',
  EXPIRING_SOON: 'EXPIRING_SOON',
  EXPIRED: 'EXPIRED',
  LOW_ROTATION: 'LOW_ROTATION'
} as const

export type StockAlertType = (typeof STOCK_ALERT_TYPES)[keyof typeof STOCK_ALERT_TYPES]

export const STOCK_ALERT_SEVERITIES = {
  INFO: 'INFO',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL'
} as const

export type StockAlertSeverity = (typeof STOCK_ALERT_SEVERITIES)[keyof typeof STOCK_ALERT_SEVERITIES]

export interface AvailabilityQuery {
  productIds: string[]
  saleId?: string
}

export interface StockAvailabilityQuery extends AvailabilityQuery {
  businessDate?: string
  timeZone?: string
  auth: StockServiceAuth
}

export interface StockOverviewQuery {
  businessDate: string
  timeZone?: string
  page: number
  pageSize: number
  auth: StockServiceAuth
}

export interface StockProductDetailQuery {
  productId: string
  businessDate: string
  timeZone?: string
  movementLimit: number
  auth: StockServiceAuth
}

export interface AvailabilityResult {
  productId: string
  availableToSell: number
  physicalQuantity: number
  committedQuantity: number
  expiredQuantity: number
  dataQuality: StockDataQuality
}

export interface StockAlert {
  type: StockAlertType
  severity: StockAlertSeverity
  productId: string
  explanation: string
  dataQuality: StockDataQuality
}

export interface PurchaseReceiptLineInput {
  itemBuyId: string
  productId: string
  quantityReceived: number
  expiryDate?: string
}

export interface PurchaseReceiptInput {
  buyId: string
  lines: PurchaseReceiptLineInput[]
  receivedAt: string
  businessDate?: string
  operationId: string
  receivedBy: string
}

export interface PurchaseAdjustmentLineInput {
  lineId: string
  productId: string
  quantity: number
  expiryDate?: string
}

export interface PurchaseAdjustmentInput {
  buyId: string
  operationId: string
  businessDate: string
  auth: StockServiceAuth
  lines: PurchaseAdjustmentLineInput[]
  reason: string
  occurredAt?: Date
}

export interface ExpiredRemovalInput {
  bucketId: string
  operationId: string
  businessDate: string
  auth: StockServiceAuth
  reason: string
  occurredAt?: Date
}

export interface SaleDeliveryInput {
  saleId: string
  deliveredAt: string
  businessDate?: string
  operationId: string
  deliveredBy: string
}

export interface StockPhysicalReturnLineInput {
  productId: string
  quantity: number
  lineId?: string
}

export interface StockPhysicalReturnInput extends StockOperationInput {
  lines: StockPhysicalReturnLineInput[]
  occurredAt?: Date
}

export interface StockErrorEnvelope {
  code: StockErrorCode
  message: string
  correlationId?: string
}

export interface ProductStockRuleContext {
  productId: string
  businessDate: string
  timeZone: string
}

export interface StockRuleBucket {
  bucketId: string
  expiryDate: string
  availableQuantity: number
  committedQuantity: number
}

export interface AvailabilityInput extends ProductStockRuleContext {
  physicalQuantity: number
  committedQuantity: number
  expiryTracking: ExpiryTracking
  baselineStatus: BaselineStatus
  expiryBuckets?: StockRuleBucket[]
}

export interface FefoAllocationInput extends ProductStockRuleContext {
  requestedQuantity: number
  buckets: StockRuleBucket[]
}

export interface StockAllocation {
  bucketId: string
  expiryDate: string
  quantity: number
}

export interface FefoAllocationResult {
  allocations: StockAllocation[]
  allocatedQuantity: number
}

export interface StockExpiryEvaluationInput extends ProductStockRuleContext {
  alertDays: number
  buckets: StockRuleBucket[]
}

export interface LowStockInput extends AvailabilityResult {
  minimum?: number
}

export interface StockSaleRecord {
  occurredAt: string
  quantity: number
  cancelled?: boolean
  active?: boolean
}

export interface StockRotationInput {
  productId: string
  productCreatedAt: string
  businessDate: string
  timeZone: string
  rotationDays: number
  sales: StockSaleRecord[]
}

export interface StockRotationResult {
  productId: string
  dataQuality: StockDataQuality
  validSaleCount: number
  validSaleQuantity: number
  alert?: StockAlert
}

export interface StockAuthContext {
  actorId: string
  canManageStock: boolean
  canApproveStockCount: boolean
}

export interface StockServiceAuth {
  actorId: string
  canManageStock: boolean
}

export interface StockSaleLineInput {
  lineId: string
  productId: string
  quantity: number
}

export interface StockSaleReleaseInput extends StockSaleLineInput {
  bucketId?: string
}

export interface StockOperationInput {
  saleId: string
  operationId: string
  businessDate: string
  timeZone?: string
  auth: StockServiceAuth
}

export interface StockSaleAvailabilityInput {
  saleId: string
  businessDate: string
  timeZone?: string
  auth: StockServiceAuth
  lines: StockSaleLineInput[]
}

export interface StockSaleCommitInput extends StockOperationInput {
  lines: StockSaleLineInput[]
  occurredAt?: Date
}

export interface StockSaleCancelInput extends StockOperationInput {
  occurredAt?: Date
}

export interface StockSaleAdjustmentInput extends StockOperationInput {
  additions?: StockSaleLineInput[]
  releases?: StockSaleReleaseInput[]
  occurredAt?: Date
}

export interface StockAggregatedLine {
  productId: string
  quantity: number
}

export interface StockAvailabilityValidationResult {
  saleId: string
  lines: StockAggregatedLine[]
  availability: AvailabilityResult[]
}

export interface StockProductSnapshot {
  productId: string
  physicalQuantity: number
  committedQuantity: number
  availableQuantity: number
  expiryTracking: ExpiryTracking
  baselineStatus: BaselineStatus
}

export interface StockProductOverviewRecord {
  productId: string
  minimum: number | null
  snapshot: StockProductSnapshot
}

export interface StockProductOverviewPage {
  total: number
  items: StockProductOverviewRecord[]
}

export const STOCK_LATEST_SALE_STATUS = {
  RECORDED: 'RECORDED',
  INCOMPLETE: 'INCOMPLETE'
} as const

export type StockLatestSaleStatus = (typeof STOCK_LATEST_SALE_STATUS)[keyof typeof STOCK_LATEST_SALE_STATUS]

export interface StockLatestSale {
  status: StockLatestSaleStatus
  occurredAt?: string
}

export interface StockLatestSaleRecord {
  productId: string
  occurredAt: Date
}

export interface StockOverviewItem {
  productId: string
  physicalQuantity: number
  committedQuantity: number
  availableToSell: number
  expiredQuantity: number
  dataQuality: StockDataQuality
  minimum: number | null
  alerts: StockAlert[]
  latestSale: StockLatestSale
}

export interface StockOverviewSummary {
  /** Totals are deliberately scoped to the returned page, not the full repository. */
  productCount: number
  physicalQuantity: number
  committedQuantity: number
  availableToSell: number
  alertCount: number
}

export interface StockOverviewResult {
  page: number
  pageSize: number
  total: number
  items: StockOverviewItem[]
  summary: StockOverviewSummary
  globalSummary: StockOverviewGlobalSummary
}

export interface StockOverviewGlobalSummary {
  belowMinimumProductCount: number
  expiringProductCount: number
  expiredProductCount: number
  lowRotationProductCount: number
  activeAlertCount: number
}

export interface StockMinimumResult {
  productId: string
  minimum: number
}

export interface StockMinimumUpdateOptions {
  correlationId?: string
  reason?: string
}

export interface StockMinimumAuditRecord {
  auditId?: string
  productId: string
  actorId: string
  previousMinimum: number | null
  newMinimum: number
  occurredAt: Date
  correlationId?: string
  reason?: string
  createdAt?: Date
}

export interface StockProductMinimum {
  productId: string
  minimum: number | null
}

export interface StockProductDetailResult {
  productId: string
  minimum: number | null
  availability: AvailabilityResult
  buckets: StockBucketSnapshot[]
  movements: StockMovementRecord[]
  alerts: StockAlert[]
}

export interface StockBucketSnapshot {
  bucketId: string
  productId: string
  expiryDate: string
  receivedQuantity: number
  availableQuantity: number
  committedQuantity: number
}

export interface StockMovementRecord {
  movementId?: string
  productId: string
  expiryBucketId?: string
  type: InventoryMovementType
  quantity: number
  occurredAt: Date
  sourceType: string
  sourceId: string
  sourceEvent: string
  operationId: string
  idempotencyKey: string
  rulesVersion: string
  sourceLineId?: string
  reason?: string
  reversesMovementId?: string
  createdBy: string
  createdAt?: Date
  updatedAt?: Date
}

export interface StockMovementQuery {
  productId?: string
  sourceType?: string
  sourceId?: string
  type?: InventoryMovementType
  limit?: number
}

export interface StockIdempotentMovementResult {
  movement: StockMovementRecord
  alreadyApplied: boolean
}

export interface StockBucketProjectionDelta {
  availableQuantityDelta: number
  committedQuantityDelta: number
  receivedQuantityDelta?: number
}

export interface StockProductProjectionDelta {
  availableQuantityDelta: number
  committedQuantityDelta: number
  physicalQuantityDelta: number
}

export interface StockOperationResult {
  status: StockOperationStatus
  operationId: string
  movementCount: number
  appliedMovementCount: number
  alreadyAppliedCount: number
  projectionCount: number
}

export interface StockRepositorySession {
  transactionId: string
}

export interface StockTransactionContext {
  session: StockRepositorySession
}

export interface StockRepository {
  withTransaction: <T>(work: (context: StockRepository & StockTransactionContext) => Promise<T>) => Promise<T>
  getProduct: (productId: string, session?: StockRepositorySession) => Promise<StockProductSnapshot | undefined>
  getProductMinimum: (productId: string, session?: StockRepositorySession) => Promise<StockProductMinimum | undefined>
  listProducts: (page: number, pageSize: number, session?: StockRepositorySession) => Promise<StockProductOverviewPage>
  getSalesHistory: (productIds: string[], businessDate: string, rotationDays: number, timeZone: string, session?: StockRepositorySession) => Promise<StockRotationInput[]>
  getLatestSales: (productIds: string[], session?: StockRepositorySession) => Promise<StockLatestSaleRecord[]>
  updateProductMinimum: (productId: string, minimum: number, session?: StockRepositorySession) => Promise<StockMinimumResult | undefined>
  insertMinimumAudit: (audit: StockMinimumAuditRecord, session?: StockRepositorySession) => Promise<StockMinimumAuditRecord>
  getBuckets: (productId: string, session?: StockRepositorySession) => Promise<StockBucketSnapshot[]>
  getBucket: (bucketId: string, session?: StockRepositorySession) => Promise<StockBucketSnapshot | undefined>
  findMovementByIdempotencyKey: (idempotencyKey: string, session?: StockRepositorySession) => Promise<StockMovementRecord | undefined>
  findMovements: (query: StockMovementQuery, session?: StockRepositorySession) => Promise<StockMovementRecord[]>
  insertMovement: (movement: StockMovementRecord, session?: StockRepositorySession) => Promise<StockMovementRecord>
  applyPhysicalBucketReceipt: (productId: string, expiryDate: string, quantity: number, session?: StockRepositorySession) => Promise<StockBucketSnapshot>
  applyBucketProjectionDelta: (bucketId: string, delta: StockBucketProjectionDelta, session?: StockRepositorySession) => Promise<void>
  applyProductProjectionDelta: (productId: string, delta: StockProductProjectionDelta, session?: StockRepositorySession) => Promise<void>
}

export interface OpeningCountRow {
  productId: string
  countedQuantity: number
  expiryDate?: string | null
}

export interface OpeningCountInput {
  operationId: string
  rows: OpeningCountRow[]
}

export interface OpeningCountConfirmationInput extends OpeningCountInput {
  approvedBy: string
  approvalId: string
}

export interface OpeningCountPlanGroup {
  productId: string
  expiryDate: string | null
  countedQuantity: number
}

export interface OpeningCountPlan {
  operationId: string
  movementType: typeof INVENTORY_MOVEMENT_TYPES.OPENING
  groups: OpeningCountPlanGroup[]
  movementCount: number
  rulesVersion: string
}

export interface OpeningCountEvidence {
  status: StockOperationStatus
  operationId: string
  approvalId?: string
  approvedBy?: string
  actorId: string
  rulesVersion: string
  movementCount: number
  businessDataMutated: boolean
  errorCode?: StockErrorCode
}

export interface OpeningCountPreview {
  plan: OpeningCountPlan
  evidence: OpeningCountEvidence
}

export interface OpeningCountWriteContext {
  actorId: string
  approvedBy: string
  approvalId: string
}

export interface OpeningCountWriterResult {
  status: Exclude<StockOperationStatus, typeof STOCK_OPERATION_STATUSES.PENDING>
  movementCount: number
  errorCode?: StockErrorCode
}

export type OpeningCountWriter = (plan: OpeningCountPlan, context: OpeningCountWriteContext) => Promise<OpeningCountWriterResult>

export interface OpeningCountOperation {
  operationId: string
  actorId: string
  approvedBy: string
  approvalId: string
  planFingerprint: string
  rulesVersion: string
  status: typeof STOCK_OPERATION_STATUSES.APPLIED
  movementCount: number
  createdAt: Date
  updatedAt: Date
}

export interface OpeningCountBucketReconciliation {
  expiryDate: string
  receivedQuantity: number
  availableQuantity: number
}

export interface StockOpeningRepository extends Omit<StockRepository, 'withTransaction'> {
  withTransaction: <T>(work: (context: StockOpeningRepository & StockTransactionContext) => Promise<T>) => Promise<T>
  getOpeningOperation: (operationId: string, session?: StockRepositorySession) => Promise<OpeningCountOperation | undefined>
  insertOpeningOperation: (operation: OpeningCountOperation, session?: StockRepositorySession) => Promise<OpeningCountOperation>
  reconcileOpeningBuckets: (productId: string, buckets: OpeningCountBucketReconciliation[], session?: StockRepositorySession) => Promise<void>
  clearOpeningBuckets: (productId: string, session?: StockRepositorySession) => Promise<void>
  reconcileOpeningProduct: (productId: string, physicalQuantity: number, actorId: string, reconciledAt: Date, session?: StockRepositorySession) => Promise<void>
}
