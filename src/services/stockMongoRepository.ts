import mongoose, { Types, type ClientSession } from 'mongoose'
import { fromZonedTime } from 'date-fns-tz'

import ProductModel from '../models/product'
import InventoryMovementModel from '../models/inventoryMovement'
import StockExpiryBucketModel from '../models/stockExpiryBucket'
import StockOpeningOperationModel from '../models/stockOpeningOperation'
import StockMinimumAuditModel from '../models/stockMinimumAudit'
import { STOCK_TIME_ZONE } from '../config/stock'
import {
  BASELINE_STATUS,
  EXPIRY_TRACKING,
  INVENTORY_MOVEMENT_TYPES,
  STOCK_ERROR_CODES,
  type BaselineStatus,
  type ExpiryTracking,
  type InventoryMovementType,
  type OpeningCountBucketReconciliation,
  type OpeningCountOperation,
  type StockBucketProjectionDelta,
  type StockBucketSnapshot,
  type StockMinimumResult,
  type StockMinimumAuditRecord,
  type StockMovementQuery,
  type StockMovementRecord,
  type StockProductOverviewPage,
  type StockProductMinimum,
  type StockProductProjectionDelta,
  type StockProductSnapshot,
  type StockRepository,
  type StockOpeningRepository,
  type StockRotationInput,
  type StockRepositorySession,
  type StockTransactionContext
} from '../interfaces/stock.interface'
import { StockServiceError } from './stock'

interface MongoProductDocument {
  _id: Types.ObjectId
  stock: number
  inventory?: {
    minimum?: number
    expiryTracking: ExpiryTracking
    baselineStatus: BaselineStatus
  }
}

interface MongoBucketDocument {
  _id: Types.ObjectId
  productId: Types.ObjectId
  expiryDate: Date
  receivedQuantity: number
  availableQuantity: number
  committedQuantity: number
}

interface MongoMovementDocument {
  _id: Types.ObjectId
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

interface MongoMovementWrite {
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
  createdAt?: Date
  updatedAt?: Date
}

interface MongoOpeningOperationDocument {
  operationId: string
  actorId: string
  approvedBy: string
  approvalId: string
  planFingerprint: string
  rulesVersion: string
  status: OpeningCountOperation['status']
  movementCount: number
  createdAt: Date
  updatedAt: Date
}

interface MongoMinimumAuditDocument {
  _id: Types.ObjectId
  productId: string
  actorId: string
  previousMinimum: number | null
  newMinimum: number
  occurredAt: Date
  correlationId?: string
  reason?: string
  createdAt: Date
}

interface MongoSalesHistoryLine {
  occurredAt?: Date
  quantity?: unknown
  active?: unknown
  status?: unknown
}

interface MongoSalesHistoryAggregationRow {
  _id: Types.ObjectId
  createdAt?: Date
  sales?: MongoSalesHistoryLine[]
}

const repositoryError = (message: string, cause?: unknown): StockServiceError => {
  const detail = cause instanceof Error ? `: ${cause.message}` : ''
  return new StockServiceError(STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR, `${message}${detail}`)
}

/** MongoDB standalone (no replica set) rejects multi-document transactions. */
const STANDALONE_TRANSACTION_ID = '__standalone__'

const isReplicaSetRequiredError = (error: unknown): boolean => {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : ''
  return message.includes('Transaction numbers are only allowed on a replica set member or mongos')
}

const recordOf = (value: unknown, field: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw repositoryError(`${field} must be an object`)
  return value as Record<string, unknown>
}

const identifierOf = (value: unknown, field: string): string => {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (value instanceof Types.ObjectId) return value.toString()
  if (typeof value === 'object' && value !== null && 'toHexString' in value && typeof value.toHexString === 'function') {
    return value.toHexString()
  }
  throw repositoryError(`${field} is missing or invalid`)
}

const objectIdOf = (value: unknown, field: string): Types.ObjectId => {
  const identifier = identifierOf(value, field)
  if (!Types.ObjectId.isValid(identifier)) throw repositoryError(`${field} is not a valid MongoDB ObjectId`)
  return new Types.ObjectId(identifier)
}

const nonEmptyStringOf = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw repositoryError(`${field} is missing or invalid`)
  return value.trim()
}

const boundedOptionalStringOf = (value: unknown, field: string, maxLength: number): string | undefined => {
  if (value === undefined) return undefined
  const stringValue = nonEmptyStringOf(value, field)
  if (stringValue.length > maxLength) throw repositoryError(`${field} exceeds its maximum length`)
  return stringValue
}

const positiveIntegerOf = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw repositoryError(`${field} must be a positive integer`)
  return value
}

const isCivilDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

const addCivilDays = (value: string, days: number): string => {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

const normalizeSaleStatus = (value: string): string => value.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')

const isCancelledSaleStatus = (value: unknown): boolean | undefined => {
  if (typeof value !== 'string') return undefined
  const normalized = normalizeSaleStatus(value)
  return normalized === 'cancelado' || normalized === 'cancelled' || normalized === 'canceled'
}

const isoTimestamp = (value: unknown): string => {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value ?? ''))
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

const mapSalesHistoryRow = (row: MongoSalesHistoryAggregationRow, businessDate: string, rotationDays: number, timeZone: string): StockRotationInput => ({
  productId: identifierOf(row._id, 'Product._id'),
  productCreatedAt: isoTimestamp(row.createdAt),
  businessDate,
  rotationDays,
  timeZone,
  sales: (row.sales ?? []).map((sale) => ({
    occurredAt: isoTimestamp(sale.occurredAt),
    quantity: typeof sale.quantity === 'number' ? sale.quantity : 0,
    ...(typeof sale.active === 'boolean' ? { active: sale.active } : {}),
    ...(isCancelledSaleStatus(sale.status) === undefined ? {} : { cancelled: isCancelledSaleStatus(sale.status) as boolean })
  }))
})

const nonNegativeIntegerOf = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw repositoryError(`${field} must be a non-negative integer`)
  return value
}

const dateOf = (value: unknown, field: string): Date => {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value))
  if (Number.isNaN(date.getTime())) throw repositoryError(`${field} is invalid`)
  return date
}

const isCanonicalCivilDate = (date: Date): boolean =>
  date.getUTCHours() === 0 &&
  date.getUTCMinutes() === 0 &&
  date.getUTCSeconds() === 0 &&
  date.getUTCMilliseconds() === 0

const civilDateOf = (value: unknown, timeZone: string = STOCK_TIME_ZONE): string => {
  const date = dateOf(value, 'expiryDate')
  if (isCanonicalCivilDate(date)) return date.toISOString().slice(0, 10)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)
  const year = parts.find(({ type }) => type === 'year')?.value
  const month = parts.find(({ type }) => type === 'month')?.value
  const day = parts.find(({ type }) => type === 'day')?.value
  if (year === undefined || month === undefined || day === undefined) throw repositoryError('Could not normalize civil date')
  return `${year}-${month}-${day}`
}

const trackingOf = (value: unknown): ExpiryTracking => {
  if (value === EXPIRY_TRACKING.TRACKED || value === EXPIRY_TRACKING.NOT_TRACKED || value === EXPIRY_TRACKING.UNKNOWN) return value
  throw repositoryError('inventory.expiryTracking is invalid')
}

const baselineOf = (value: unknown): BaselineStatus => {
  if (value === BASELINE_STATUS.UNVERIFIED || value === BASELINE_STATUS.RECONCILED) return value
  throw repositoryError('inventory.baselineStatus is invalid')
}

const mapOpeningOperationDocument = (document: MongoOpeningOperationDocument): OpeningCountOperation => ({
  operationId: document.operationId,
  actorId: document.actorId,
  approvedBy: document.approvedBy,
  approvalId: document.approvalId,
  planFingerprint: document.planFingerprint,
  rulesVersion: document.rulesVersion,
  status: document.status,
  movementCount: document.movementCount,
  createdAt: new Date(document.createdAt.getTime()),
  updatedAt: new Date(document.updatedAt.getTime())
})

export const mapMinimumAuditDocumentToRecord = (document: unknown): StockMinimumAuditRecord => {
  const audit = recordOf(document, 'StockMinimumAudit')
  const previousMinimum = audit.previousMinimum === null ? null : nonNegativeIntegerOf(audit.previousMinimum, 'previousMinimum')
  return {
    auditId: identifierOf(audit._id, 'StockMinimumAudit._id'),
    productId: nonEmptyStringOf(audit.productId, 'productId'),
    actorId: nonEmptyStringOf(audit.actorId, 'actorId'),
    previousMinimum,
    newMinimum: nonNegativeIntegerOf(audit.newMinimum, 'newMinimum'),
    occurredAt: dateOf(audit.occurredAt, 'occurredAt'),
    ...(audit.correlationId === undefined ? {} : { correlationId: nonEmptyStringOf(audit.correlationId, 'correlationId') }),
    ...(audit.reason === undefined ? {} : { reason: nonEmptyStringOf(audit.reason, 'reason') }),
    ...(audit.createdAt === undefined ? {} : { createdAt: dateOf(audit.createdAt, 'createdAt') })
  }
}

const toMinimumAuditWrite = (audit: StockMinimumAuditRecord): Omit<MongoMinimumAuditDocument, '_id' | 'createdAt'> => ({
  productId: nonEmptyStringOf(audit.productId, 'productId'),
  actorId: nonEmptyStringOf(audit.actorId, 'actorId'),
  previousMinimum: audit.previousMinimum === null ? null : nonNegativeIntegerOf(audit.previousMinimum, 'previousMinimum'),
  newMinimum: nonNegativeIntegerOf(audit.newMinimum, 'newMinimum'),
  occurredAt: dateOf(audit.occurredAt, 'occurredAt'),
  ...(audit.correlationId === undefined ? {} : { correlationId: boundedOptionalStringOf(audit.correlationId, 'correlationId', 128) }),
  ...(audit.reason === undefined ? {} : { reason: boundedOptionalStringOf(audit.reason, 'reason', 200) })
})

export const mapProductDocumentToStockSnapshot = (document: unknown, committedQuantity: number): StockProductSnapshot => {
  const product = recordOf(document, 'Product')
  const physicalQuantity = nonNegativeIntegerOf(product.stock, 'Product.stock')
  const committed = nonNegativeIntegerOf(committedQuantity, 'committedQuantity')
  if (committed > physicalQuantity) throw repositoryError('Committed quantity exceeds physical quantity')
  const inventory = product.inventory === undefined ? undefined : recordOf(product.inventory, 'Product.inventory')
  return {
    productId: identifierOf(product._id, 'Product._id'),
    physicalQuantity,
    committedQuantity: committed,
    availableQuantity: physicalQuantity - committed,
    expiryTracking: trackingOf(inventory?.expiryTracking ?? EXPIRY_TRACKING.UNKNOWN),
    baselineStatus: baselineOf(inventory?.baselineStatus ?? BASELINE_STATUS.UNVERIFIED)
  }
}

export const mapBucketDocumentToStockSnapshot = (document: unknown): StockBucketSnapshot => {
  const bucket = recordOf(document, 'StockExpiryBucket')
  return {
    bucketId: identifierOf(bucket._id, 'StockExpiryBucket._id'),
    productId: identifierOf(bucket.productId, 'StockExpiryBucket.productId'),
    expiryDate: civilDateOf(bucket.expiryDate),
    receivedQuantity: nonNegativeIntegerOf(bucket.receivedQuantity, 'receivedQuantity'),
    availableQuantity: nonNegativeIntegerOf(bucket.availableQuantity, 'availableQuantity'),
    committedQuantity: nonNegativeIntegerOf(bucket.committedQuantity, 'committedQuantity')
  }
}

export const mapMovementDocumentToStockRecord = (document: unknown): StockMovementRecord => {
  const movement = recordOf(document, 'InventoryMovement')
  const type = movement.type
  if (!Object.values(INVENTORY_MOVEMENT_TYPES).includes(type as InventoryMovementType)) throw repositoryError('InventoryMovement.type is invalid')
  const sourceLineId = movement.sourceLineId === undefined ? undefined : identifierOf(movement.sourceLineId, 'sourceLineId')
  const reversesMovementId = movement.reversesMovementId === undefined ? undefined : identifierOf(movement.reversesMovementId, 'reversesMovementId')
  const occurredAt = dateOf(movement.occurredAt, 'occurredAt')
  const createdAt = dateOf(movement.createdAt, 'createdAt')
  const updatedAt = dateOf(movement.updatedAt, 'updatedAt')
  return {
    movementId: identifierOf(movement._id, 'InventoryMovement._id'),
    productId: identifierOf(movement.productId, 'productId'),
    expiryBucketId: movement.expiryBucketId === undefined ? undefined : identifierOf(movement.expiryBucketId, 'expiryBucketId'),
    type: type as InventoryMovementType,
    quantity: positiveIntegerOf(movement.quantity, 'quantity'),
    occurredAt,
    sourceType: nonEmptyStringOf(movement.sourceType, 'sourceType'),
    sourceId: nonEmptyStringOf(movement.sourceId, 'sourceId'),
    sourceEvent: nonEmptyStringOf(movement.sourceEvent, 'sourceEvent'),
    operationId: nonEmptyStringOf(movement.operationId, 'operationId'),
    idempotencyKey: nonEmptyStringOf(movement.idempotencyKey, 'idempotencyKey'),
    rulesVersion: nonEmptyStringOf(movement.rulesVersion, 'rulesVersion'),
    sourceLineId,
    reason: movement.reason === undefined ? undefined : nonEmptyStringOf(movement.reason, 'reason'),
    reversesMovementId,
    createdBy: identifierOf(movement.createdBy, 'createdBy'),
    createdAt,
    updatedAt
  }
}

const toMovementWrite = (movement: StockMovementRecord): MongoMovementWrite => ({
  productId: objectIdOf(movement.productId, 'productId'),
  ...(movement.expiryBucketId === undefined ? {} : { expiryBucketId: objectIdOf(movement.expiryBucketId, 'expiryBucketId') }),
  type: movement.type,
  quantity: positiveIntegerOf(movement.quantity, 'quantity'),
  occurredAt: dateOf(movement.occurredAt, 'occurredAt'),
  sourceType: movement.sourceType,
  sourceId: movement.sourceId,
  sourceEvent: movement.sourceEvent,
  operationId: movement.operationId,
  idempotencyKey: movement.idempotencyKey,
  rulesVersion: movement.rulesVersion,
  ...(movement.sourceLineId === undefined ? {} : { sourceLineId: objectIdOf(movement.sourceLineId, 'sourceLineId') }),
  ...(movement.reason === undefined ? {} : { reason: movement.reason }),
  ...(movement.reversesMovementId === undefined ? {} : { reversesMovementId: objectIdOf(movement.reversesMovementId, 'reversesMovementId') }),
  createdBy: objectIdOf(movement.createdBy, 'createdBy'),
  ...(movement.createdAt === undefined ? {} : { createdAt: dateOf(movement.createdAt, 'createdAt') }),
  ...(movement.updatedAt === undefined ? {} : { updatedAt: dateOf(movement.updatedAt, 'updatedAt') })
})

const movementQuery = (query: StockMovementQuery): Record<string, unknown> => ({
  ...(query.sourceType === undefined ? {} : { sourceType: query.sourceType }),
  ...(query.sourceId === undefined ? {} : { sourceId: query.sourceId }),
  ...(query.type === undefined ? {} : { type: query.type })
})

const ledgerCommittedQuantity = (movements: StockMovementRecord[]): number => movements.reduce((total, movement) => {
  if (movement.type === INVENTORY_MOVEMENT_TYPES.SALE_COMMIT) return total + movement.quantity
  if (movement.type === INVENTORY_MOVEMENT_TYPES.SALE_CANCEL) return total - movement.quantity
  if (movement.type === INVENTORY_MOVEMENT_TYPES.SALE_ADJUSTMENT && movement.reason === 'addition') return total + movement.quantity
  if (movement.type === INVENTORY_MOVEMENT_TYPES.SALE_ADJUSTMENT && movement.reason === 'release') return total - movement.quantity
  if (movement.type === INVENTORY_MOVEMENT_TYPES.SALE_DELIVERED_OUT) return total - movement.quantity
  return total
}, 0)

const validateProjectionDelta = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value)) throw repositoryError(`${field} must be an integer`)
}

export class MongooseStockRepository implements StockOpeningRepository {
  private readonly sessions = new Map<string, ClientSession>()

  async withTransaction<T> (work: (context: StockOpeningRepository & StockTransactionContext) => Promise<T>): Promise<T> {
    let session: ClientSession
    try {
      session = await mongoose.startSession()
    } catch (error) {
      throw repositoryError('Could not start MongoDB session', error)
    }

    const transactionId = String(session.id)
    this.sessions.set(transactionId, session)
    let result!: T
    let failure: unknown
    try {
      await session.withTransaction(async () => {
        result = await work(this.transactionContext(transactionId))
      })
    } catch (error) {
      failure = error
    }
    try {
      await session.endSession()
    } catch (error) {
      if (failure === undefined) failure = error
    } finally {
      this.sessions.delete(transactionId)
    }
    if (failure !== undefined) {
      // Local/dev Mongo often runs as a standalone node. Retry without a
      // multi-document transaction so stock commits can still proceed.
      if (isReplicaSetRequiredError(failure)) {
        return await work(this.transactionContext(STANDALONE_TRANSACTION_ID))
      }
      if (failure instanceof StockServiceError) throw failure
      throw repositoryError(`MongoDB transaction ${transactionId} failed`, failure)
    }
    return result
  }

  async getProduct (productId: string, session?: StockRepositorySession): Promise<StockProductSnapshot | undefined> {
    try {
      const productObjectId = objectIdOf(productId, 'productId')
      const productQuery = ProductModel.findById(productObjectId)
      const mongoSession = this.mongoSessionOf(session)
      if (mongoSession !== undefined) void productQuery.session(mongoSession)
      const document = await productQuery.lean<MongoProductDocument>().exec()
      if (document === null) return undefined
      return await this.snapshotOf(document as unknown as MongoProductDocument, productObjectId, mongoSession)
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw repositoryError(`Could not read product ${productId}`, error)
    }
  }

  async listProducts (page: number, pageSize: number, session?: StockRepositorySession): Promise<StockProductOverviewPage> {
    positiveIntegerOf(page, 'page')
    positiveIntegerOf(pageSize, 'pageSize')
    const skip = (page - 1) * pageSize
    if (!Number.isSafeInteger(skip)) throw repositoryError('Product page offset exceeds safe integer bounds')
    try {
      const mongoSession = this.mongoSessionOf(session)
      const productQuery = ProductModel.find({})
        .select('_id stock inventory')
        .sort({ _id: 1 })
        .skip(skip)
        .limit(pageSize)
      const countQuery = ProductModel.countDocuments({})
      if (mongoSession !== undefined) {
        void productQuery.session(mongoSession)
        void countQuery.session(mongoSession)
      }
      const [documents, total] = await Promise.all([
        productQuery.lean<MongoProductDocument[]>().exec(),
        countQuery.exec()
      ])
      const items = []
      for (const document of documents) {
        const product = document as unknown as MongoProductDocument
        const productObjectId = objectIdOf(product._id, 'Product._id')
        const snapshot = await this.snapshotOf(product, productObjectId, mongoSession)
        const minimum = product.inventory?.minimum === undefined
          ? null
          : nonNegativeIntegerOf(product.inventory.minimum, 'Product.inventory.minimum')
        items.push({ productId: snapshot.productId, minimum, snapshot })
      }
      return { total, items }
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw repositoryError('Could not list stock products', error)
    }
  }

  async getSalesHistory (productIds: string[], businessDate: string, rotationDays: number, timeZone: string, session?: StockRepositorySession): Promise<StockRotationInput[]> {
    if (!isCivilDate(businessDate) || !Number.isSafeInteger(rotationDays) || rotationDays <= 0 || productIds.length === 0) return []
    const productObjectIds = productIds.map((productId) => objectIdOf(productId, 'productId'))
    const historyStart = addCivilDays(businessDate, -rotationDays)
    const historyStartInstant = fromZonedTime(`${historyStart}T00:00:00`, timeZone)
    const businessDateInstant = fromZonedTime(`${businessDate}T00:00:00`, timeZone)
    try {
      const mongoSession = this.mongoSessionOf(session)
      const pipeline = [
        { $match: { _id: { $in: productObjectIds } } },
        { $project: { _id: 1, createdAt: 1 } },
        {
          $lookup: {
            from: 'itemsales',
            let: { productId: '$_id' },
            pipeline: [
              { $match: { $expr: { $eq: ['$idProducto', '$$productId'] } } },
              { $lookup: { from: 'sales', localField: 'idVenta', foreignField: '_id', as: 'sale' } },
              { $unwind: '$sale' },
              { $match: { 'sale.createdAt': { $gte: historyStartInstant, $lt: businessDateInstant } } },
              { $project: { _id: 0, occurredAt: '$sale.createdAt', quantity: '$cantidad', active: '$estado', status: '$sale.estado' } }
            ],
            as: 'sales'
          }
        }
      ]
      const aggregateQuery = ProductModel.aggregate<MongoSalesHistoryAggregationRow>(pipeline)
      if (mongoSession !== undefined) void aggregateQuery.session(mongoSession)
      const rows = await aggregateQuery.exec()
      return rows.map((row) => mapSalesHistoryRow(row, businessDate, rotationDays, timeZone))
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw repositoryError('Could not aggregate product sales history', error)
    }
  }

  async getProductMinimum (productId: string, session?: StockRepositorySession): Promise<StockProductMinimum | undefined> {
    try {
      const productObjectId = objectIdOf(productId, 'productId')
      const mongoSession = this.mongoSessionOf(session)
      const query = ProductModel.findById(productObjectId).select('_id inventory.minimum')
      if (mongoSession !== undefined) void query.session(mongoSession)
      const document = await query.lean<MongoProductDocument>().exec()
      if (document === null) return undefined
      const product = document as unknown as MongoProductDocument
      const minimum = product.inventory?.minimum === undefined
        ? null
        : nonNegativeIntegerOf(product.inventory.minimum, 'Product.inventory.minimum')
      return { productId: identifierOf(product._id, 'Product._id'), minimum }
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw repositoryError(`Could not read minimum for product ${productId}`, error)
    }
  }

  async updateProductMinimum (productId: string, minimum: number, session?: StockRepositorySession): Promise<StockMinimumResult | undefined> {
    const productObjectId = objectIdOf(productId, 'productId')
    nonNegativeIntegerOf(minimum, 'minimum')
    try {
      const mongoSession = this.mongoSessionOf(session)
      const query = ProductModel.findOneAndUpdate(
        { _id: productObjectId },
        { $set: { 'inventory.minimum': minimum } },
        { new: true, runValidators: true }
      )
      if (mongoSession !== undefined) void query.session(mongoSession)
      const document = await query.select('_id inventory.minimum').lean<MongoProductDocument>().exec()
      if (document === null) return undefined
      const product = document as unknown as MongoProductDocument
      const storedMinimum = product.inventory?.minimum
      if (storedMinimum === undefined) throw repositoryError(`Product ${productId} minimum was not returned`)
      return { productId: identifierOf(product._id, 'Product._id'), minimum: nonNegativeIntegerOf(storedMinimum, 'Product.inventory.minimum') }
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw repositoryError(`Could not update minimum for product ${productId}`, error)
    }
  }

  async insertMinimumAudit (audit: StockMinimumAuditRecord, session?: StockRepositorySession): Promise<StockMinimumAuditRecord> {
    try {
      const document = toMinimumAuditWrite(audit)
      const mongoSession = this.mongoSessionOf(session)
      const inserted = mongoSession === undefined
        ? await StockMinimumAuditModel.create([document])
        : await StockMinimumAuditModel.create([document], { session: mongoSession })
      if (inserted.length !== 1) throw repositoryError('Stock minimum audit insert did not return exactly one document')
      const insertedValue: unknown = inserted[0]
      const insertedRecord = recordOf(insertedValue, 'StockMinimumAudit')
      const rawDocument: unknown = typeof insertedRecord.toObject === 'function' ? insertedRecord.toObject() : insertedRecord
      return mapMinimumAuditDocumentToRecord(rawDocument)
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw repositoryError(`Could not insert minimum audit for ${audit.productId}`, error)
    }
  }

  async getBuckets (productId: string, session?: StockRepositorySession): Promise<StockBucketSnapshot[]> {
    try {
      const productObjectId = objectIdOf(productId, 'productId')
      const documents = await this.bucketDocuments(productObjectId, this.mongoSessionOf(session))
      return documents.map(mapBucketDocumentToStockSnapshot)
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw repositoryError(`Could not read buckets for ${productId}`, error)
    }
  }

  async getBucket (bucketId: string, session?: StockRepositorySession): Promise<StockBucketSnapshot | undefined> {
    try {
      const bucketObjectId = objectIdOf(bucketId, 'bucketId')
      const mongoSession = this.mongoSessionOf(session)
      const query = StockExpiryBucketModel.findById(bucketObjectId)
      if (mongoSession !== undefined) void query.session(mongoSession)
      const document = await query.lean<MongoBucketDocument>().exec()
      return document === null ? undefined : mapBucketDocumentToStockSnapshot(document)
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw repositoryError(`Could not read bucket ${bucketId}`, error)
    }
  }

  async findMovementByIdempotencyKey (idempotencyKey: string, session?: StockRepositorySession): Promise<StockMovementRecord | undefined> {
    try {
      const query = InventoryMovementModel.findOne({ idempotencyKey })
      const mongoSession = this.mongoSessionOf(session)
      if (mongoSession !== undefined) void query.session(mongoSession)
      const document = await query.lean<MongoMovementDocument>().exec()
      return document === null ? undefined : mapMovementDocumentToStockRecord(document)
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw repositoryError(`Could not find movement for idempotency key ${idempotencyKey}`, error)
    }
  }

  async findMovements (query: StockMovementQuery, session?: StockRepositorySession): Promise<StockMovementRecord[]> {
    try {
      const filter = movementQuery(query)
      if (query.productId !== undefined) filter.productId = objectIdOf(query.productId, 'productId')
      const movementQueryResult = InventoryMovementModel.find(filter)
      const mongoSession = this.mongoSessionOf(session)
      if (mongoSession !== undefined) void movementQueryResult.session(mongoSession)
      if (query.productId !== undefined) {
        void movementQueryResult.sort({ occurredAt: -1, _id: -1 })
        if (query.limit !== undefined) void movementQueryResult.limit(positiveIntegerOf(query.limit, 'limit'))
      }
      const documents = await movementQueryResult.lean<MongoMovementDocument[]>().exec()
      return documents.map(mapMovementDocumentToStockRecord)
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw repositoryError('Could not read inventory movements', error)
    }
  }

  async insertMovement (movement: StockMovementRecord, session?: StockRepositorySession): Promise<StockMovementRecord> {
    try {
      const document = toMovementWrite(movement)
      const mongoSession = this.mongoSessionOf(session)
      const inserted = mongoSession === undefined
        ? await InventoryMovementModel.create([document])
        : await InventoryMovementModel.create([document], { session: mongoSession })
      if (inserted.length !== 1) throw repositoryError('Inventory movement insert did not return exactly one document')
      return mapMovementDocumentToStockRecord(inserted[0])
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw repositoryError(`Could not insert movement ${movement.idempotencyKey}`, error)
    }
  }

  async applyPhysicalBucketReceipt (productId: string, expiryDate: string, quantity: number, session?: StockRepositorySession): Promise<StockBucketSnapshot> {
    if (!isCivilDate(expiryDate)) throw repositoryError('expiryDate must be a valid civil date')
    positiveIntegerOf(quantity, 'quantity')
    try {
      const productObjectId = objectIdOf(productId, 'productId')
      const query = StockExpiryBucketModel.findOneAndUpdate(
        {
          productId: productObjectId,
          expiryDate,
          receivedQuantity: { $gte: 0 },
          availableQuantity: { $gte: 0 },
          committedQuantity: { $gte: 0 }
        },
        {
          $setOnInsert: {
            productId: productObjectId,
            expiryDate,
            receivedQuantity: 0,
            availableQuantity: 0,
            committedQuantity: 0
          },
          $inc: {
            receivedQuantity: quantity,
            availableQuantity: quantity
          }
        },
        { new: true, upsert: true }
      )
      const mongoSession = this.mongoSessionOf(session)
      if (mongoSession !== undefined) void query.session(mongoSession)
      const document = await query.lean<MongoBucketDocument>().exec()
      if (document === null) throw repositoryError(`Stock bucket for ${productId} and ${expiryDate} was not updated`)
      const snapshot = mapBucketDocumentToStockSnapshot(document)
      if (snapshot.receivedQuantity !== snapshot.availableQuantity + snapshot.committedQuantity) throw repositoryError(`Stock bucket for ${productId} and ${expiryDate} is inconsistent`)
      return snapshot
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw repositoryError(`Could not receive stock bucket for ${productId}`, error)
    }
  }

  async applyBucketProjectionDelta (bucketId: string, delta: StockBucketProjectionDelta, session?: StockRepositorySession): Promise<void> {
    validateProjectionDelta(delta.availableQuantityDelta, 'availableQuantityDelta')
    validateProjectionDelta(delta.committedQuantityDelta, 'committedQuantityDelta')
    validateProjectionDelta(delta.receivedQuantityDelta ?? 0, 'receivedQuantityDelta')
    try {
      const filter: Record<string, unknown> = { _id: objectIdOf(bucketId, 'bucketId') }
      if (delta.availableQuantityDelta < 0) filter.availableQuantity = { $gte: -delta.availableQuantityDelta }
      if (delta.committedQuantityDelta < 0) filter.committedQuantity = { $gte: -delta.committedQuantityDelta }
      if ((delta.receivedQuantityDelta ?? 0) < 0) filter.receivedQuantity = { $gte: -(delta.receivedQuantityDelta ?? 0) }
      const increments: Record<string, number> = {
        availableQuantity: delta.availableQuantityDelta,
        committedQuantity: delta.committedQuantityDelta
      }
      if ((delta.receivedQuantityDelta ?? 0) !== 0) increments.receivedQuantity = delta.receivedQuantityDelta as number
      const query = StockExpiryBucketModel.updateOne(filter, {
        $inc: increments
      })
      const mongoSession = this.mongoSessionOf(session)
      if (mongoSession !== undefined) void query.session(mongoSession)
      const result = await query.exec()
      if (result.matchedCount !== 1) throw repositoryError(`Stock bucket ${bucketId} was not updated`)
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw repositoryError(`Could not update stock bucket ${bucketId}`, error)
    }
  }

  async applyProductProjectionDelta (productId: string, delta: StockProductProjectionDelta, session?: StockRepositorySession): Promise<void> {
    validateProjectionDelta(delta.availableQuantityDelta, 'availableQuantityDelta')
    validateProjectionDelta(delta.committedQuantityDelta, 'committedQuantityDelta')
    validateProjectionDelta(delta.physicalQuantityDelta, 'physicalQuantityDelta')
    try {
      const productObjectId = objectIdOf(productId, 'productId')
      const mongoSession = this.mongoSessionOf(session)
      if (delta.physicalQuantityDelta === 0) {
        const query = ProductModel.findById(productObjectId)
        if (mongoSession !== undefined) void query.session(mongoSession)
        const document = await query.select('_id').lean<MongoProductDocument>().exec()
        if (document === null) throw repositoryError(`Product ${productId} was not found`)
        return
      }

      const filter: Record<string, unknown> = { _id: productObjectId }
      if (delta.physicalQuantityDelta < 0) filter.stock = { $gte: -delta.physicalQuantityDelta }
      const query = ProductModel.updateOne(filter, { $inc: { stock: delta.physicalQuantityDelta } })
      if (mongoSession !== undefined) void query.session(mongoSession)
      const result = await query.exec()
      if (result.matchedCount !== 1) throw repositoryError(`Product ${productId} was not updated`)
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw repositoryError(`Could not update product ${productId}`, error)
    }
  }

  async getOpeningOperation (operationId: string, session?: StockRepositorySession): Promise<OpeningCountOperation | undefined> {
    try {
      const mongoSession = this.mongoSessionOf(session)
      const query = StockOpeningOperationModel.findOne({ operationId })
      if (mongoSession !== undefined) void query.session(mongoSession)
      const document = await query.lean<MongoOpeningOperationDocument>().exec()
      return document === null ? undefined : mapOpeningOperationDocument(document)
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw repositoryError(`Could not find opening-count operation ${operationId}`, error)
    }
  }

  async insertOpeningOperation (operation: OpeningCountOperation, session?: StockRepositorySession): Promise<OpeningCountOperation> {
    try {
      const mongoSession = this.mongoSessionOf(session)
      const inserted = mongoSession === undefined
        ? await StockOpeningOperationModel.create([operation])
        : await StockOpeningOperationModel.create([operation], { session: mongoSession })
      if (inserted.length !== 1) throw repositoryError('Opening-count operation insert did not return exactly one document')
      return mapOpeningOperationDocument(inserted[0].toObject() as MongoOpeningOperationDocument)
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw repositoryError(`Could not insert opening-count operation ${operation.operationId}`, error)
    }
  }

  async reconcileOpeningBuckets (productId: string, buckets: OpeningCountBucketReconciliation[], session?: StockRepositorySession): Promise<void> {
    try {
      const productObjectId = objectIdOf(productId, 'productId')
      const mongoSession = this.mongoSessionOf(session)
      const existing = await this.bucketDocuments(productObjectId, mongoSession)
      const desired = new Map(buckets.map((bucket) => [bucket.expiryDate, bucket]))

      for (const bucket of existing) {
        const expiryDate = civilDateOf(bucket.expiryDate)
        const target = desired.get(expiryDate)
        const updateQuery = StockExpiryBucketModel.updateOne(
          { _id: bucket._id },
          {
            $set: target === undefined
              ? { receivedQuantity: 0, availableQuantity: 0 }
              : { receivedQuantity: target.receivedQuantity, availableQuantity: target.availableQuantity }
          }
        )
        if (mongoSession !== undefined) void updateQuery.session(mongoSession)
        const result = await updateQuery.exec()
        if (result.matchedCount !== 1) throw repositoryError(`Stock bucket ${bucket._id.toString()} was not reconciled`)
        if (target !== undefined) desired.delete(expiryDate)
      }

      for (const bucket of desired.values()) {
        const updateQuery = StockExpiryBucketModel.findOneAndUpdate(
          { productId: productObjectId, expiryDate: bucket.expiryDate },
          {
            $setOnInsert: {
              productId: productObjectId,
              expiryDate: bucket.expiryDate,
              committedQuantity: 0
            },
            $set: {
              receivedQuantity: bucket.receivedQuantity,
              availableQuantity: bucket.availableQuantity
            }
          },
          { upsert: true, new: true }
        )
        if (mongoSession !== undefined) void updateQuery.session(mongoSession)
        const document = await updateQuery.lean<MongoBucketDocument>().exec()
        if (document === null) throw repositoryError(`Stock bucket for ${productId} and ${bucket.expiryDate} was not reconciled`)
      }
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw repositoryError(`Could not reconcile opening buckets for ${productId}`, error)
    }
  }

  async clearOpeningBuckets (productId: string, session?: StockRepositorySession): Promise<void> {
    try {
      const productObjectId = objectIdOf(productId, 'productId')
      const mongoSession = this.mongoSessionOf(session)
      const existing = await this.bucketDocuments(productObjectId, mongoSession)
      if (existing.some((bucket) => bucket.committedQuantity > 0)) {
        throw new StockServiceError(STOCK_ERROR_CODES.STOCK_BUCKET_HAS_COMMITMENTS, `Opening count cannot clear committed buckets for ${productId}`)
      }
      const query = StockExpiryBucketModel.deleteMany({ productId: productObjectId })
      if (mongoSession !== undefined) void query.session(mongoSession)
      await query.exec()
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw repositoryError(`Could not clear opening buckets for ${productId}`, error)
    }
  }

  async reconcileOpeningProduct (productId: string, physicalQuantity: number, actorId: string, reconciledAt: Date, session?: StockRepositorySession): Promise<void> {
    try {
      const productObjectId = objectIdOf(productId, 'productId')
      const actorObjectId = objectIdOf(actorId, 'actorId')
      nonNegativeIntegerOf(physicalQuantity, 'physicalQuantity')
      const mongoSession = this.mongoSessionOf(session)
      const query = ProductModel.updateOne(
        { _id: productObjectId, 'inventory.baselineStatus': BASELINE_STATUS.UNVERIFIED },
        {
          $set: {
            stock: physicalQuantity,
            'inventory.baselineStatus': BASELINE_STATUS.RECONCILED,
            'inventory.lastReconciledAt': reconciledAt,
            'inventory.lastReconciledBy': actorObjectId
          }
        }
      )
      if (mongoSession !== undefined) void query.session(mongoSession)
      const result = await query.exec()
      if (result.matchedCount !== 1) throw new StockServiceError(STOCK_ERROR_CODES.STOCK_BASELINE_ALREADY_RECONCILED, `Product ${productId} baseline is no longer unverified`)
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw repositoryError(`Could not reconcile opening product ${productId}`, error)
    }
  }

  private transactionContext (transactionId: string): StockOpeningRepository & StockTransactionContext {
    return {
      session: { transactionId },
      withTransaction: this.withTransaction.bind(this),
      getProduct: async (productId, session) => await this.getProduct(productId, session),
      getProductMinimum: async (productId, session) => await this.getProductMinimum(productId, session),
      listProducts: async (page, pageSize, session) => await this.listProducts(page, pageSize, session),
      getSalesHistory: async (productIds, businessDate, rotationDays, timeZone, session) => await this.getSalesHistory(productIds, businessDate, rotationDays, timeZone, session),
      updateProductMinimum: async (productId, minimum, session) => await this.updateProductMinimum(productId, minimum, session),
      insertMinimumAudit: async (audit, session) => await this.insertMinimumAudit(audit, session),
      getBuckets: async (productId, session) => await this.getBuckets(productId, session),
      getBucket: async (bucketId, session) => await this.getBucket(bucketId, session),
      findMovementByIdempotencyKey: async (key, session) => await this.findMovementByIdempotencyKey(key, session),
      findMovements: async (query, session) => await this.findMovements(query, session),
      insertMovement: async (movement, session) => await this.insertMovement(movement, session),
      applyPhysicalBucketReceipt: async (productId, expiryDate, quantity, session) => await this.applyPhysicalBucketReceipt(productId, expiryDate, quantity, session),
      applyBucketProjectionDelta: async (bucketId, delta, session) => await this.applyBucketProjectionDelta(bucketId, delta, session),
      applyProductProjectionDelta: async (productId, delta, session) => await this.applyProductProjectionDelta(productId, delta, session),
      getOpeningOperation: async (operationId, session) => await this.getOpeningOperation(operationId, session),
      insertOpeningOperation: async (operation, session) => await this.insertOpeningOperation(operation, session),
      reconcileOpeningBuckets: async (productId, buckets, session) => await this.reconcileOpeningBuckets(productId, buckets, session),
      clearOpeningBuckets: async (productId, session) => await this.clearOpeningBuckets(productId, session),
      reconcileOpeningProduct: async (productId, physicalQuantity, actorId, reconciledAt, session) => await this.reconcileOpeningProduct(productId, physicalQuantity, actorId, reconciledAt, session)
    }
  }

  private mongoSessionOf (session?: StockRepositorySession): ClientSession | undefined {
    if (session === undefined) return undefined
    if (session.transactionId === STANDALONE_TRANSACTION_ID) return undefined
    const mongoSession = this.sessions.get(session.transactionId)
    if (mongoSession === undefined) throw repositoryError(`MongoDB session ${session.transactionId} is unavailable`)
    return mongoSession
  }

  private async bucketDocuments (productId: Types.ObjectId, session?: ClientSession): Promise<MongoBucketDocument[]> {
    const query = StockExpiryBucketModel.find({ productId }).sort({ expiryDate: 1, _id: 1 })
    if (session !== undefined) void query.session(session)
    const documents = await query.lean<MongoBucketDocument[]>().exec()
    return documents as unknown as MongoBucketDocument[]
  }

  private async snapshotOf (product: MongoProductDocument, productObjectId: Types.ObjectId, session?: ClientSession): Promise<StockProductSnapshot> {
    const inventoryTracking = product.inventory?.expiryTracking
    let committedQuantity = 0
    if (inventoryTracking === EXPIRY_TRACKING.TRACKED) {
      const buckets = await this.bucketDocuments(productObjectId, session)
      committedQuantity = buckets.reduce((total, bucket) => total + nonNegativeIntegerOf(bucket.committedQuantity, 'committedQuantity'), 0)
    } else if (inventoryTracking === EXPIRY_TRACKING.NOT_TRACKED) {
      const movements = await this.ledgerMovements(productObjectId, session)
      committedQuantity = ledgerCommittedQuantity(movements)
      if (committedQuantity < 0) throw repositoryError(`Ledger commitments are negative for ${product._id.toString()}`)
    }
    return mapProductDocumentToStockSnapshot(product, committedQuantity)
  }

  private async ledgerMovements (productId: Types.ObjectId, session?: ClientSession): Promise<StockMovementRecord[]> {
    const query = InventoryMovementModel.find({
      productId,
      type: {
        $in: [
          INVENTORY_MOVEMENT_TYPES.SALE_COMMIT,
          INVENTORY_MOVEMENT_TYPES.SALE_CANCEL,
          INVENTORY_MOVEMENT_TYPES.SALE_ADJUSTMENT,
          INVENTORY_MOVEMENT_TYPES.SALE_DELIVERED_OUT
        ]
      }
    })
    if (session !== undefined) void query.session(session)
    const documents = await query.lean<MongoMovementDocument[]>().exec()
    return (documents as unknown as MongoMovementDocument[]).map(mapMovementDocumentToStockRecord)
  }
}

export const createMongooseStockRepository = (): StockRepository => new MongooseStockRepository()
export const createMongooseStockOpeningRepository = (): StockOpeningRepository => new MongooseStockRepository()
