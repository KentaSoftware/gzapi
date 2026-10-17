import { Schema, model } from 'mongoose'
import type { StockExpiryBucket } from '../interfaces/stock.interface'
import { STOCK_TIME_ZONE } from '../config/stock'

const isNonNegativeInteger = (value: number): boolean => Number.isInteger(value) && value >= 0
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const STOCK_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: STOCK_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
})

const normalizeDateOnly = (value: Date | string): Date => {
  if (typeof value === 'string' && DATE_ONLY_PATTERN.test(value)) {
    const [year, month, day] = value.split('-').map(Number)
    return new Date(Date.UTC(year, month - 1, day))
  }

  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return new Date(Number.NaN)

  const parts = STOCK_DATE_FORMATTER.formatToParts(date)
  const year = Number(parts.find(({ type }) => type === 'year')?.value)
  const month = Number(parts.find(({ type }) => type === 'month')?.value)
  const day = Number(parts.find(({ type }) => type === 'day')?.value)
  return new Date(Date.UTC(year, month - 1, day))
}

const StockExpiryBucketSchema = new Schema<StockExpiryBucket>(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'product',
      required: true
    },
    expiryDate: {
      type: Date,
      required: true,
      set: normalizeDateOnly
    },
    receivedQuantity: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: isNonNegativeInteger,
        message: 'receivedQuantity must be a non-negative integer'
      }
    },
    availableQuantity: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: isNonNegativeInteger,
        message: 'availableQuantity must be a non-negative integer'
      }
    },
    committedQuantity: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: isNonNegativeInteger,
        message: 'committedQuantity must be a non-negative integer'
      }
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
)

StockExpiryBucketSchema.index(
  { productId: 1, expiryDate: 1 },
  { unique: true, name: 'idx_stock_expiry_bucket_product_expiry_unique' }
)
StockExpiryBucketSchema.index(
  { expiryDate: 1, productId: 1 },
  { name: 'idx_stock_expiry_bucket_expiry_product' }
)

const StockExpiryBucketModel = model('stockExpiryBucket', StockExpiryBucketSchema)
export default StockExpiryBucketModel
