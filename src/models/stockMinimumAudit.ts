import { Schema, model } from 'mongoose'
import type { StockMinimumAuditRecord } from '../interfaces/stock.interface'

const STOCK_MINIMUM_AUDIT_STRING_LIMITS = {
  PRODUCT_ID: 64,
  ACTOR_ID: 64,
  CORRELATION_ID: 128,
  REASON: 200
} as const

const isNonNegativeSafeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0

const StockMinimumAuditSchema = new Schema<StockMinimumAuditRecord>(
  {
    productId: {
      type: String,
      required: true,
      trim: true,
      maxlength: STOCK_MINIMUM_AUDIT_STRING_LIMITS.PRODUCT_ID
    },
    actorId: {
      type: String,
      required: true,
      trim: true,
      maxlength: STOCK_MINIMUM_AUDIT_STRING_LIMITS.ACTOR_ID
    },
    previousMinimum: {
      type: Number,
      required: false,
      default: null,
      min: 0,
      validate: {
        validator: (value: number | null): boolean => value === null || isNonNegativeSafeInteger(value),
        message: 'previousMinimum must be null or a safe non-negative integer'
      }
    },
    newMinimum: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: isNonNegativeSafeInteger,
        message: 'newMinimum must be a safe non-negative integer'
      }
    },
    occurredAt: {
      type: Date,
      required: true
    },
    correlationId: {
      type: String,
      required: false,
      trim: true,
      maxlength: STOCK_MINIMUM_AUDIT_STRING_LIMITS.CORRELATION_ID
    },
    reason: {
      type: String,
      required: false,
      trim: true,
      maxlength: STOCK_MINIMUM_AUDIT_STRING_LIMITS.REASON
    }
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false
  }
)

StockMinimumAuditSchema.index(
  { productId: 1, occurredAt: -1 },
  { name: 'idx_stock_minimum_audit_product_occurred_at' }
)
StockMinimumAuditSchema.index(
  { correlationId: 1 },
  { name: 'idx_stock_minimum_audit_correlation' }
)

StockMinimumAuditSchema.pre('save', function () {
  if (!this.isNew) throw new Error('Stock minimum audits are append-only')
})

StockMinimumAuditSchema.pre(['findOneAndUpdate', 'replaceOne', 'updateMany', 'updateOne', 'findOneAndReplace'], function () {
  throw new Error('Stock minimum audits are append-only')
})

StockMinimumAuditSchema.pre(['deleteOne', 'deleteMany', 'findOneAndDelete'], function () {
  throw new Error('Stock minimum audits are append-only')
})
StockMinimumAuditSchema.pre('deleteOne', { document: true, query: false }, function () {
  throw new Error('Stock minimum audits are append-only')
})
StockMinimumAuditSchema.pre('bulkWrite', function () {
  throw new Error('Stock minimum audits are append-only')
})

const StockMinimumAuditModel = model<StockMinimumAuditRecord>('stockMinimumAudit', StockMinimumAuditSchema)

export { StockMinimumAuditSchema }
export default StockMinimumAuditModel
