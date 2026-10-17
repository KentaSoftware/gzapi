import { Schema, model } from 'mongoose'
import { CommercialFact } from '../interfaces/commercialFact.interface'

const COMMERCIAL_FACT_TYPES: string[] = [
  'SALE_PAYMENT',
  'SALE_REFUND',
  'PURCHASE_PAYMENT',
  'PURCHASE_RECEIPT',
  'PURCHASE_ADJUSTMENT',
  'SALE_DELIVERY',
  'SALE_CANCELLATION',
  'SALE_PHYSICAL_RETURN'
]

const CommercialFactSchema = new Schema<CommercialFact>(
  {
    type: {
      type: String,
      enum: COMMERCIAL_FACT_TYPES,
      required: true
    },
    aggregateType: {
      type: String,
      required: true
    },
    aggregateId: {
      type: String,
      required: true
    },
    amount: {
      type: Number,
      required: false
    },
    businessDate: {
      type: Date,
      required: true
    },
    actorId: {
      type: String,
      required: true
    },
    sourceReference: {
      type: String,
      required: true
    },
    correlationId: {
      type: String,
      required: false
    },
    idempotencyKey: {
      type: String,
      required: true
    },
    payloadHash: {
      type: String,
      required: true
    },
    status: {
      type: String,
      enum: ['PENDING', 'APPLIED', 'FAILED_RECOVERABLE'],
      required: true,
      default: 'PENDING'
    },
    reason: {
      type: String,
      required: false
    },
    lines: {
      type: [Schema.Types.Mixed],
      required: false
    }
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false
  }
)

// Idempotency: one operation per (type, aggregate, key).
CommercialFactSchema.index(
  { type: 1, aggregateId: 1, idempotencyKey: 1 },
  { unique: true, name: 'idx_unique_fact_idempotency' }
)

// Lookup facts by aggregate and operation type.
CommercialFactSchema.index(
  { aggregateId: 1, type: 1 },
  { name: 'idx_aggregate_type' }
)

// Trace requests by correlation identifier.
CommercialFactSchema.index(
  { correlationId: 1 },
  { name: 'idx_correlation' }
)

const CommercialFactModel = model('commercialFact', CommercialFactSchema)
export default CommercialFactModel
