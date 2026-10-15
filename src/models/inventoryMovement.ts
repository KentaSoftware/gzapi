import { Schema, model } from 'mongoose'
import type { InventoryMovement } from '../interfaces/stock.interface'
import { INVENTORY_MOVEMENT_TYPES } from '../interfaces/stock.interface'

const INVENTORY_MOVEMENT_STRING_LIMITS = {
  SOURCE_TYPE: 64,
  SOURCE_ID: 128,
  SOURCE_EVENT: 128,
  OPERATION_ID: 128,
  IDEMPOTENCY_KEY: 256,
  RULES_VERSION: 64,
  REASON: 500
} as const

const isPositiveInteger = (value: number): boolean => Number.isInteger(value) && value > 0

const InventoryMovementSchema = new Schema<InventoryMovement>(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'product',
      required: true
    },
    expiryBucketId: {
      type: Schema.Types.ObjectId,
      ref: 'stockExpiryBucket'
    },
    type: {
      type: String,
      enum: Object.values(INVENTORY_MOVEMENT_TYPES),
      required: true
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: isPositiveInteger,
        message: 'quantity must be a positive integer'
      }
    },
    occurredAt: {
      type: Date,
      required: true
    },
    sourceType: {
      type: String,
      required: true,
      trim: true,
      maxlength: INVENTORY_MOVEMENT_STRING_LIMITS.SOURCE_TYPE
    },
    sourceId: {
      type: String,
      required: true,
      trim: true,
      maxlength: INVENTORY_MOVEMENT_STRING_LIMITS.SOURCE_ID
    },
    sourceEvent: {
      type: String,
      required: true,
      trim: true,
      maxlength: INVENTORY_MOVEMENT_STRING_LIMITS.SOURCE_EVENT
    },
    operationId: {
      type: String,
      required: true,
      trim: true,
      maxlength: INVENTORY_MOVEMENT_STRING_LIMITS.OPERATION_ID
    },
    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: INVENTORY_MOVEMENT_STRING_LIMITS.IDEMPOTENCY_KEY
    },
    rulesVersion: {
      type: String,
      required: true,
      trim: true,
      maxlength: INVENTORY_MOVEMENT_STRING_LIMITS.RULES_VERSION
    },
    sourceLineId: {
      type: Schema.Types.ObjectId
    },
    reason: {
      type: String,
      trim: true,
      maxlength: INVENTORY_MOVEMENT_STRING_LIMITS.REASON
    },
    reversesMovementId: {
      type: Schema.Types.ObjectId,
      ref: 'inventoryMovement'
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'user',
      required: true
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
)

InventoryMovementSchema.index(
  { idempotencyKey: 1 },
  { unique: true, name: 'idx_inventory_movement_idempotency_unique' }
)
InventoryMovementSchema.index(
  { productId: 1, occurredAt: -1 },
  { name: 'idx_inventory_movement_product_occurred_at' }
)
InventoryMovementSchema.index(
  { expiryBucketId: 1, occurredAt: -1 },
  { name: 'idx_inventory_movement_expiry_bucket_occurred_at' }
)
InventoryMovementSchema.index(
  { sourceType: 1, sourceId: 1 },
  { name: 'idx_inventory_movement_source' }
)

const InventoryMovementModel = model('inventoryMovement', InventoryMovementSchema)
export default InventoryMovementModel
