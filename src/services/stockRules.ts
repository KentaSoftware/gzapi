import {
  BASELINE_STATUS,
  EXPIRY_TRACKING,
  STOCK_ALERT_SEVERITIES,
  STOCK_ALERT_TYPES,
  STOCK_DATA_QUALITY,
  STOCK_ERROR_CODES,
  type AvailabilityInput,
  type AvailabilityResult,
  type FefoAllocationInput,
  type FefoAllocationResult,
  type LowStockInput,
  type StockAlert,
  type StockAllocation,
  type StockExpiryEvaluationInput,
  type StockRotationInput,
  type StockRotationResult,
  type StockRuleBucket,
  type StockErrorCode
} from '../interfaces/stock.interface'

const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const isCivilDate = (value: string): boolean => {
  if (!CIVIL_DATE_PATTERN.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

const isValidQuantity = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isValidTimeZone = (value: string): boolean => {
  if (typeof value !== 'string' || value.trim() === '') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

const isValidContext = (productId: string, businessDate: string, timeZone: string): boolean =>
  typeof productId === 'string' && productId.trim() !== '' && isCivilDate(businessDate) && isValidTimeZone(timeZone)

const isValidBucket = (bucket: unknown): bucket is StockRuleBucket => {
  if (typeof bucket !== 'object' || bucket === null || Array.isArray(bucket)) return false
  const candidate = bucket as Record<string, unknown>
  return typeof candidate.bucketId === 'string' && candidate.bucketId.trim() !== '' &&
    typeof candidate.expiryDate === 'string' && isCivilDate(candidate.expiryDate) &&
    isValidQuantity(candidate.availableQuantity) && isValidQuantity(candidate.committedQuantity)
}

const invalidResult = (input: AvailabilityInput): AvailabilityResult => ({
  productId: typeof input.productId === 'string' ? input.productId : '',
  availableToSell: 0,
  physicalQuantity: isValidQuantity(input.physicalQuantity) ? input.physicalQuantity : 0,
  committedQuantity: isValidQuantity(input.committedQuantity) ? input.committedQuantity : 0,
  expiredQuantity: 0,
  dataQuality: STOCK_DATA_QUALITY.INCOMPLETE
})

const duplicateBucketIds = (buckets: StockRuleBucket[]): boolean => {
  const ids = new Set<string>()
  for (const bucket of buckets) {
    if (ids.has(bucket.bucketId)) return true
    ids.add(bucket.bucketId)
  }
  return false
}

const validateBuckets = (buckets: unknown): buckets is StockRuleBucket[] => {
  if (!Array.isArray(buckets) || !buckets.every(isValidBucket)) return false
  return !duplicateBucketIds(buckets)
}

const civilDateToNumber = (value: string): number => Date.parse(`${value}T00:00:00.000Z`)

const addCivilDays = (value: string, days: number): string => {
  const date = new Date(civilDateToNumber(value))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export class StockRuleError extends Error {
  readonly code: StockErrorCode

  constructor (code: StockErrorCode, message: string) {
    super(message)
    this.name = 'StockRuleError'
    this.code = code
  }
}

export const calculateAvailability = (input: AvailabilityInput): AvailabilityResult => {
  if (!isValidContext(input.productId, input.businessDate, input.timeZone) ||
    !isValidQuantity(input.physicalQuantity) || !isValidQuantity(input.committedQuantity) ||
    input.baselineStatus !== BASELINE_STATUS.RECONCILED || input.expiryTracking === EXPIRY_TRACKING.UNKNOWN) {
    return invalidResult(input)
  }

  if (input.committedQuantity > input.physicalQuantity) return invalidResult(input)

  if (input.expiryTracking === EXPIRY_TRACKING.NOT_TRACKED) {
    if (input.expiryBuckets !== undefined && (!Array.isArray(input.expiryBuckets) || input.expiryBuckets.length > 0)) return invalidResult(input)
    return {
      productId: input.productId,
      availableToSell: input.physicalQuantity - input.committedQuantity,
      physicalQuantity: input.physicalQuantity,
      committedQuantity: input.committedQuantity,
      expiredQuantity: 0,
      dataQuality: STOCK_DATA_QUALITY.COMPLETE
    }
  }

  if (input.expiryTracking !== EXPIRY_TRACKING.TRACKED || !Array.isArray(input.expiryBuckets) || !validateBuckets(input.expiryBuckets)) return invalidResult(input)

  let bucketPhysical = 0
  let bucketCommitted = 0
  let expiredQuantity = 0
  let nonExpiredPhysical = 0
  let nonExpiredCommitted = 0
  for (const bucket of input.expiryBuckets) {
    const physical = bucket.availableQuantity + bucket.committedQuantity
    bucketPhysical += physical
    bucketCommitted += bucket.committedQuantity
    if (bucket.expiryDate < input.businessDate) {
      expiredQuantity += physical
    } else {
      nonExpiredPhysical += physical
      nonExpiredCommitted += bucket.committedQuantity
    }
  }

  if (bucketPhysical !== input.physicalQuantity || bucketCommitted !== input.committedQuantity) return invalidResult(input)

  return {
    productId: input.productId,
    availableToSell: Math.max(0, nonExpiredPhysical - nonExpiredCommitted),
    physicalQuantity: input.physicalQuantity,
    committedQuantity: input.committedQuantity,
    expiredQuantity,
    dataQuality: STOCK_DATA_QUALITY.COMPLETE
  }
}

export const allocateFefo = (input: FefoAllocationInput): FefoAllocationResult => {
  if (!isValidContext(input.productId, input.businessDate, input.timeZone) ||
    !isValidQuantity(input.requestedQuantity) || !Array.isArray(input.buckets) ||
    !validateBuckets(input.buckets) || input.buckets.some((bucket) => bucket.expiryDate < input.businessDate)) {
    throw new StockRuleError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'FEFO input is incomplete or invalid')
  }
  if (input.requestedQuantity === 0) return { allocations: [], allocatedQuantity: 0 }

  const ordered = [...input.buckets].sort((left, right) => {
    const expiryComparison = left.expiryDate.localeCompare(right.expiryDate)
    if (expiryComparison !== 0) return expiryComparison
    return left.bucketId.localeCompare(right.bucketId)
  })
  const allocations: StockAllocation[] = []
  let remaining = input.requestedQuantity
  for (const bucket of ordered) {
    if (bucket.availableQuantity === 0) continue
    const quantity = Math.min(remaining, bucket.availableQuantity)
    allocations.push({ bucketId: bucket.bucketId, expiryDate: bucket.expiryDate, quantity })
    remaining -= quantity
    if (remaining === 0) break
  }
  if (remaining > 0) throw new StockRuleError(STOCK_ERROR_CODES.STOCK_INSUFFICIENT, `Insufficient stock for ${input.productId}`)
  return { allocations, allocatedQuantity: input.requestedQuantity }
}

const incompleteAlert = (productId: string, type: typeof STOCK_ALERT_TYPES.EXPIRED | typeof STOCK_ALERT_TYPES.EXPIRING_SOON, explanation: string): StockAlert => ({
  type,
  severity: STOCK_ALERT_SEVERITIES.WARNING,
  productId,
  explanation,
  dataQuality: STOCK_DATA_QUALITY.INCOMPLETE
})

export const evaluateExpiry = (input: StockExpiryEvaluationInput): StockAlert[] => {
  if (!isValidContext(input.productId, input.businessDate, input.timeZone) ||
    !isValidQuantity(input.alertDays) || !Array.isArray(input.buckets) || !validateBuckets(input.buckets)) {
    return [incompleteAlert(input.productId, STOCK_ALERT_TYPES.EXPIRING_SOON, `Product ${input.productId} has incomplete expiry data`)]
  }

  const horizon = addCivilDays(input.businessDate, input.alertDays)
  const alerts: StockAlert[] = []
  const ordered = [...input.buckets].sort((left, right) => {
    const expiryComparison = left.expiryDate.localeCompare(right.expiryDate)
    if (expiryComparison !== 0) return expiryComparison
    return left.bucketId.localeCompare(right.bucketId)
  })
  for (const bucket of ordered) {
    if (bucket.availableQuantity === 0) continue
    if (bucket.expiryDate < input.businessDate) {
      alerts.push({
        type: STOCK_ALERT_TYPES.EXPIRED,
        severity: STOCK_ALERT_SEVERITIES.WARNING,
        productId: input.productId,
        explanation: `Product ${input.productId} has ${bucket.availableQuantity} units expired on ${bucket.expiryDate}`,
        dataQuality: STOCK_DATA_QUALITY.COMPLETE
      })
    } else if (bucket.expiryDate <= horizon) {
      alerts.push({
        type: STOCK_ALERT_TYPES.EXPIRING_SOON,
        severity: STOCK_ALERT_SEVERITIES.WARNING,
        productId: input.productId,
        explanation: `Product ${input.productId} has ${bucket.availableQuantity} units expiring on ${bucket.expiryDate}`,
        dataQuality: STOCK_DATA_QUALITY.COMPLETE
      })
    }
  }
  return alerts
}

export const evaluateLowStock = (input: LowStockInput): StockAlert | undefined => {
  const hasMinimum = input.minimum !== undefined && isValidQuantity(input.minimum)
  if (input.dataQuality !== STOCK_DATA_QUALITY.COMPLETE || !hasMinimum || !isValidQuantity(input.availableToSell)) {
    return {
      type: STOCK_ALERT_TYPES.LOW_STOCK,
      severity: STOCK_ALERT_SEVERITIES.WARNING,
      productId: input.productId,
      explanation: `Product ${input.productId} has incomplete stock threshold data`,
      dataQuality: STOCK_DATA_QUALITY.INCOMPLETE
    }
  }
  if (input.availableToSell === 0) {
    return {
      type: STOCK_ALERT_TYPES.CRITICAL_STOCK,
      severity: STOCK_ALERT_SEVERITIES.CRITICAL,
      productId: input.productId,
      explanation: `Product ${input.productId} has no units available to sell`,
      dataQuality: STOCK_DATA_QUALITY.COMPLETE
    }
  }
  if (input.availableToSell > (input.minimum as number)) return undefined
  return {
    type: STOCK_ALERT_TYPES.LOW_STOCK,
    severity: STOCK_ALERT_SEVERITIES.WARNING,
    productId: input.productId,
    explanation: `Product ${input.productId} has ${input.availableToSell} units available against a minimum of ${input.minimum as number}`,
    dataQuality: STOCK_DATA_QUALITY.COMPLETE
  }
}

const civilDateFromTimestamp = (value: unknown, timeZone: string): string | undefined => {
  if (typeof value !== 'string') return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime()) || !isValidTimeZone(timeZone)) return undefined
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  const day = parts.find((part) => part.type === 'day')?.value
  if (year === undefined || month === undefined || day === undefined) return undefined
  return `${year}-${month}-${day}`
}

const isValidSaleStatus = (sale: unknown): sale is StockRotationInput['sales'][number] => {
  if (typeof sale !== 'object' || sale === null || Array.isArray(sale)) return false
  const candidate = sale as Record<string, unknown>
  return (candidate.cancelled === undefined || typeof candidate.cancelled === 'boolean') &&
    (candidate.active === undefined || typeof candidate.active === 'boolean')
}

export const evaluateLowRotation = (input: StockRotationInput): StockRotationResult => {
  const baseResult = { productId: input.productId, validSaleCount: 0, validSaleQuantity: 0 }
  if (typeof input.productId !== 'string' || input.productId.trim() === '' || !isCivilDate(input.businessDate) ||
    !isValidTimeZone(input.timeZone) || !isValidQuantity(input.rotationDays) || input.rotationDays === 0 ||
    !Array.isArray(input.sales)) return { ...baseResult, dataQuality: STOCK_DATA_QUALITY.INSUFFICIENT_HISTORY }

  const createdDate = civilDateFromTimestamp(input.productCreatedAt, input.timeZone)
  const historyStart = addCivilDays(input.businessDate, -input.rotationDays)
  if (createdDate === undefined || createdDate > historyStart) return { ...baseResult, dataQuality: STOCK_DATA_QUALITY.INSUFFICIENT_HISTORY }

  const validSales: string[] = []
  let validSaleQuantity = 0
  for (const sale of input.sales) {
    if (!isValidSaleStatus(sale)) return { ...baseResult, dataQuality: STOCK_DATA_QUALITY.INSUFFICIENT_HISTORY }
    const saleDate = civilDateFromTimestamp(sale.occurredAt, input.timeZone)
    if (saleDate === undefined || !isValidQuantity(sale.quantity) || sale.quantity === 0) return { ...baseResult, dataQuality: STOCK_DATA_QUALITY.INSUFFICIENT_HISTORY }
    if (sale.cancelled !== true && sale.active !== false && saleDate >= historyStart && saleDate < input.businessDate) {
      validSales.push(saleDate)
      validSaleQuantity += sale.quantity
    }
  }

  const result: StockRotationResult = {
    productId: input.productId,
    dataQuality: STOCK_DATA_QUALITY.COMPLETE,
    validSaleCount: validSales.length,
    validSaleQuantity
  }
  if (validSales.length === 0) {
    result.alert = {
      type: STOCK_ALERT_TYPES.LOW_ROTATION,
      severity: STOCK_ALERT_SEVERITIES.WARNING,
      productId: input.productId,
      explanation: `Product ${input.productId} had zero valid sales in the last ${input.rotationDays} complete calendar days`,
      dataQuality: STOCK_DATA_QUALITY.COMPLETE
    }
  }
  return result
}

export const evaluateLowRotationAlert = evaluateLowRotation

export const calculateStockAvailability = calculateAvailability
export const allocateFEFO = allocateFefo
export const evaluateExpiryAlerts = evaluateExpiry
