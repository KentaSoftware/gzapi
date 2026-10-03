export type CommercialFactType =
  | 'SALE_PAYMENT'
  | 'SALE_REFUND'
  | 'PURCHASE_PAYMENT'
  | 'PURCHASE_RECEIPT'
  | 'PURCHASE_ADJUSTMENT'
  | 'SALE_DELIVERY'
  | 'SALE_CANCELLATION'
  | 'SALE_PHYSICAL_RETURN'

export type CommercialErrorCode =
  | 'SALE_ALREADY_PAID'
  | 'SALE_PAYMENT_FORBIDDEN'
  | 'SALE_DELIVERY_INVALID'
  | 'SALE_CANCELLATION_INVALID'
  | 'SALE_PHYSICAL_RETURN_INVALID'
  | 'REFUND_EXCEEDS_COLLECTED'
  | 'PURCHASE_ALREADY_PAID'
  | 'PURCHASE_PARTIAL_RECEIPT_UNSUPPORTED'
  | 'PURCHASE_ALREADY_RECEIVED'
  | 'PURCHASE_ADJUSTMENT_INVALID'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'AUTHENTICATION_INVALID'
  | 'PERMISSION_DENIED'
  | 'MIGRATION_PREFLIGHT_FAILED'
  | 'SIMULATION_CONTRACT_INCOMPATIBLE'
  | 'FEATURE_UNAVAILABLE'

export type CommercialFactLine = Record<string, unknown>

export interface CommercialFact {
  type: CommercialFactType
  aggregateType: string
  aggregateId: string
  amount?: number
  businessDate: Date
  actorId: string
  sourceReference: string
  correlationId?: string
  idempotencyKey: string
  payloadHash: string
  reason?: string
  lines?: CommercialFactLine[]
  createdAt: Date
}

export interface CommercialFactInput {
  aggregateId: string
  businessDate: Date
  idempotencyKey: string
  reason?: string
  amount?: number
  lines?: CommercialFactLine[]
}

export interface CommercialFactResult {
  fact: CommercialFact
  replayed: boolean
}

export interface StockPort {
  commitSale: (fact: CommercialFact) => Promise<void>
  receivePurchase: (fact: CommercialFact) => Promise<void>
  applyPurchaseAdjustment: (fact: CommercialFact) => Promise<void>
  applyPhysicalReturn: (fact: CommercialFact) => Promise<void>
}

export interface FinancePort {
  recordSalePayment: (fact: CommercialFact) => Promise<void>
  recordSaleRefund: (fact: CommercialFact) => Promise<void>
  recordPurchasePayment: (fact: CommercialFact) => Promise<void>
}

export interface RoutePlanReader {
  readSavedPlan: (planId: string) => Promise<unknown>
}
