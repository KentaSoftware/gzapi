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
  EXPIRED_BUCKET_HAS_COMMITMENTS: 'EXPIRED_BUCKET_HAS_COMMITMENTS'
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
