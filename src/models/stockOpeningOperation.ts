import { Schema, model } from 'mongoose'
import type { OpeningCountOperation } from '../interfaces/stock.interface'
import { STOCK_OPERATION_STATUSES } from '../interfaces/stock.interface'

const StockOpeningOperationSchema = new Schema<OpeningCountOperation>(
  {
    operationId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 128
    },
    actorId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64
    },
    approvedBy: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64
    },
    approvalId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 128
    },
    planFingerprint: {
      type: String,
      required: true,
      trim: true,
      maxlength: 128
    },
    rulesVersion: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64
    },
    status: {
      type: String,
      enum: [STOCK_OPERATION_STATUSES.APPLIED],
      required: true
    },
    movementCount: {
      type: Number,
      required: true,
      min: 0,
      validate: Number.isSafeInteger
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
)

StockOpeningOperationSchema.index(
  { operationId: 1 },
  { unique: true, name: 'idx_stock_opening_operation_operation_unique' }
)

const StockOpeningOperationModel = model('stockOpeningOperation', StockOpeningOperationSchema)
export default StockOpeningOperationModel
