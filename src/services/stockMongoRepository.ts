import mongoose, { Types, type ClientSession } from 'mongoose'

import ProductModel from '../models/product'
import InventoryMovementModel from '../models/inventoryMovement'
import StockExpiryBucketModel from '../models/stockExpiryBucket'
import { STOCK_TIME_ZONE } from '../config/stock'
import {
  BASELINE_STATUS,
  EXPIRY_TRACKING,
  INVENTORY_MOVEMENT_TYPES,
  STOCK_ERROR_CODES,
  type BaselineStatus,
  type ExpiryTracking,
  type InventoryMovementType,
  type StockBucketProjectionDelta,
  type StockBucketSnapshot,
  type StockMovementQuery,
  type StockMovementRecord,
  type StockProductProjectionDelta,
  type StockProductSnapshot,
  type StockRepository,
  type StockRepositorySession,
  type StockTransactionContext
} from '../interfaces/stock.interface'
import { StockServiceError } from './stock'

interface MongoProductDocument {
  _id: Types.ObjectId
  stock: number
  inventory?: {
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

const repositoryError = (message: string, cause?: unknown): StockServiceError => {
  const detail = cause instanceof Error ? `: ${cause.message}` : ''
  return new StockServiceError(STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR, `${message}${detail}`)
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

const positiveIntegerOf = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw repositoryError(`${field} must be a positive integer`)
  return value
}

const isCivilDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

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

export class MongooseStockRepository implements StockRepository {
  private readonly sessions = new Map<string, ClientSession>()

  async withTransaction<T> (work: (context: StockRepository & StockTransactionContext) => Promise<T>): Promise<T> {
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
      const product = document as unknown as MongoProductDocument
      const inventoryTracking = product.inventory?.expiryTracking
      let committedQuantity = 0
      if (inventoryTracking === EXPIRY_TRACKING.TRACKED) {
        const buckets = await this.bucketDocuments(productObjectId, mongoSession)
        committedQuantity = buckets.reduce((total, bucket) => total + nonNegativeIntegerOf(bucket.committedQuantity, 'committedQuantity'), 0)
      } else if (inventoryTracking === EXPIRY_TRACKING.NOT_TRACKED) {
        const movements = await this.ledgerMovements(productObjectId, mongoSession)
        committedQuantity = ledgerCommittedQuantity(movements)
        if (committedQuantity < 0) throw repositoryError(`Ledger commitments are negative for ${productId}`)
      }
      return mapProductDocumentToStockSnapshot(product, committedQuantity)
    } catch (error) {
      if (error instanceof StockServiceError) throw error
      throw repositoryError(`Could not read product ${productId}`, error)
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
      const movementQueryResult = InventoryMovementModel.find(movementQuery(query))
      const mongoSession = this.mongoSessionOf(session)
      if (mongoSession !== undefined) void movementQueryResult.session(mongoSession)
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

  private transactionContext (transactionId: string): StockRepository & StockTransactionContext {
    return {
      session: { transactionId },
      withTransaction: this.withTransaction.bind(this),
      getProduct: async (productId, session) => await this.getProduct(productId, session),
      getBuckets: async (productId, session) => await this.getBuckets(productId, session),
      findMovementByIdempotencyKey: async (key, session) => await this.findMovementByIdempotencyKey(key, session),
      findMovements: async (query, session) => await this.findMovements(query, session),
      insertMovement: async (movement, session) => await this.insertMovement(movement, session),
      applyPhysicalBucketReceipt: async (productId, expiryDate, quantity, session) => await this.applyPhysicalBucketReceipt(productId, expiryDate, quantity, session),
      applyBucketProjectionDelta: async (bucketId, delta, session) => await this.applyBucketProjectionDelta(bucketId, delta, session),
      applyProductProjectionDelta: async (productId, delta, session) => await this.applyProductProjectionDelta(productId, delta, session)
    }
  }

  private mongoSessionOf (session?: StockRepositorySession): ClientSession | undefined {
    if (session === undefined) return undefined
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
