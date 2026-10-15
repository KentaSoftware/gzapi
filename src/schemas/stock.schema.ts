import { z } from 'zod'
import {
  BASELINE_STATUS,
  EXPIRY_TRACKING,
  STOCK_ALERT_SEVERITIES,
  STOCK_ALERT_TYPES,
  STOCK_DATA_QUALITY,
  STOCK_ERROR_CODES,
  type StockErrorCode
} from '../interfaces/stock.interface'

const objectIdSchema = z.string().trim().regex(/^[a-fA-F0-9]{24}$/, 'value must be an ObjectId')

const isCivilDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

const isIsoDateTime = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false
  if (!isCivilDate(value.slice(0, 10))) return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime())
}

const operationIdSchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'operationId must be a bounded identifier')

const nonNegativeIntegerSchema = z.number().finite().int().nonnegative()
const positiveIntegerSchema = z.number().finite().int().positive()
const isoDateTimeSchema = z.string().refine(isIsoDateTime, 'value must be an ISO date-time')
const civilDateSchema = z.string().refine(isCivilDate, 'value must be a civil date')
const safeNonNegativeIntegerSchema = nonNegativeIntegerSchema.refine(Number.isSafeInteger, 'value must be a safe integer')

const availabilityQuerySchema = z.object({
  productIds: z.array(objectIdSchema).min(1).max(100),
  saleId: objectIdSchema.optional()
}).strict()

const purchaseReceiptLineInputSchema = z.object({
  itemBuyId: objectIdSchema,
  productId: objectIdSchema,
  quantityReceived: positiveIntegerSchema,
  expiryDate: civilDateSchema.optional()
}).strict()

const purchaseReceiptInputSchema = z.object({
  buyId: objectIdSchema,
  lines: z.array(purchaseReceiptLineInputSchema).min(1).max(1000),
  receivedAt: isoDateTimeSchema,
  operationId: operationIdSchema,
  receivedBy: objectIdSchema
}).strict()

const productInventoryConfigSchema = z.object({
  minimum: nonNegativeIntegerSchema,
  expiryTracking: z.enum(Object.values(EXPIRY_TRACKING) as [string, ...string[]]),
  baselineStatus: z.enum(Object.values(BASELINE_STATUS) as [string, ...string[]]),
  lastReconciledAt: isoDateTimeSchema.optional(),
  lastReconciledBy: objectIdSchema.optional()
}).strict()

const stockErrorEnvelopeSchema = z.object({
  code: z.enum(Object.values(STOCK_ERROR_CODES) as [StockErrorCode, ...StockErrorCode[]]),
  message: z.string().trim().min(1).max(500),
  correlationId: z.string().trim().min(1).max(128).optional()
}).strict()

const stockAlertSchema = z.object({
  type: z.enum(Object.values(STOCK_ALERT_TYPES) as [string, ...string[]]),
  severity: z.enum(Object.values(STOCK_ALERT_SEVERITIES) as [string, ...string[]]),
  productId: objectIdSchema,
  explanation: z.string().trim().min(1).max(500),
  dataQuality: z.enum(Object.values(STOCK_DATA_QUALITY) as [string, ...string[]])
}).strict()

const openingCountRowSchema = z.object({
  productId: objectIdSchema,
  countedQuantity: safeNonNegativeIntegerSchema,
  expiryDate: civilDateSchema.nullable().optional()
}).strict()

const openingCountInputSchema = z.object({
  operationId: operationIdSchema,
  rows: z.array(openingCountRowSchema).min(1).max(10000)
}).strict()

const openingCountConfirmationInputSchema = openingCountInputSchema.extend({
  approvedBy: objectIdSchema,
  approvalId: operationIdSchema
}).strict()

export {
  availabilityQuerySchema,
  purchaseReceiptLineInputSchema,
  purchaseReceiptInputSchema,
  productInventoryConfigSchema,
  stockErrorEnvelopeSchema,
  stockAlertSchema,
  openingCountRowSchema,
  openingCountInputSchema,
  openingCountConfirmationInputSchema
}
