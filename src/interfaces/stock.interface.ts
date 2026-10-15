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
  EXPIRED_BUCKET_HAS_COMMITMENTS: 'EXPIRED_BUCKET_HAS_COMMITMENTS',
  STOCK_IDEMPOTENCY_CONFLICT: 'STOCK_IDEMPOTENCY_CONFLICT',
  STOCK_REPOSITORY_ERROR: 'STOCK_REPOSITORY_ERROR'
} as const

export type StockErrorCode = (typeof STOCK_ERROR_CODES)[keyof typeof STOCK_ERROR_CODES]

export const STOCK_OPERATION_STATUSES = {
  PENDING: 'PENDING',
  APPLIED: 'APPLIED',
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
  operationId: string
  receivedBy: string
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
}

export interface StockMovementQuery {
  sourceType?: string
  sourceId?: string
  type?: InventoryMovementType
}

export interface StockIdempotentMovementResult {
  movement: StockMovementRecord
  alreadyApplied: boolean
}

export interface StockBucketProjectionDelta {
  availableQuantityDelta: number
  committedQuantityDelta: number
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
  getBuckets: (productId: string, session?: StockRepositorySession) => Promise<StockBucketSnapshot[]>
  findMovementByIdempotencyKey: (idempotencyKey: string, session?: StockRepositorySession) => Promise<StockMovementRecord | undefined>
  findMovements: (query: StockMovementQuery, session?: StockRepositorySession) => Promise<StockMovementRecord[]>
  insertMovement: (movement: StockMovementRecord, session?: StockRepositorySession) => Promise<StockMovementRecord>
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
}

export type OpeningCountWriter = (plan: OpeningCountPlan, context: OpeningCountWriteContext) => Promise<OpeningCountWriterResult>
