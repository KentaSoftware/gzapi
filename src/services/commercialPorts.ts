import { createHash } from 'node:crypto'
import { Types } from 'mongoose'
import BuyModel from '../models/buy'
import SaleModel from '../models/sale'
import { STOCK_TIME_ZONE } from '../config/stock'
import {
  CommercialFact,
  CommercialFactError,
  DeliveryPort,
  FinancePort,
  RoutePlanReader,
  StockPort,
  type CommercialFactLine,
  type StockSaleReference
} from '../interfaces/commercialFact.interface'
import { STOCK_ERROR_CODES, type PurchaseReceiptInput, type SaleDeliveryInput, type StockSaleCommitInput } from '../interfaces/stock.interface'
import { MongooseStockRepository } from './stockMongoRepository'
import { StockService, StockServiceError } from './stock'
import { recomputeForSale } from './routePlanOperational'

// Phase 0 Finance port adapter. Finance derives cash only from explicit payment
// and refund facts. This adapter writes the legacy compatibility projections
// (`sales.paidAt`, `buys.paidAt`) and treats the immutable refund fact itself as
// the record, since refunds have no legacy projection.
export const financePortAdapter: FinancePort = {
  async recordSalePayment (fact: CommercialFact): Promise<void> {
    await SaleModel.updateOne(
      { _id: new Types.ObjectId(fact.aggregateId) },
      { $set: { paidAt: fact.businessDate } }
    )
  },

  async recordSaleRefund (): Promise<void> {
    // Acknowledged only: refunds have no legacy projection; the fact is the record.
  },

  async recordPurchasePayment (fact: CommercialFact): Promise<void> {
    await BuyModel.updateOne(
      { _id: new Types.ObjectId(fact.aggregateId) },
      { $set: { paidAt: fact.businessDate } }
    )
  }
}

const stockService = new StockService(new MongooseStockRepository())

const invalidStockReference = (message: string): StockServiceError => new StockServiceError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, message)

const identifierOf = (value: unknown, field: string): string => {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (value instanceof Types.ObjectId) return value.toString()
  if (typeof value === 'object' && value !== null && 'toHexString' in value && typeof value.toHexString === 'function') return value.toHexString()
  throw invalidStockReference(`${field} is required`)
}

const lineRecordOf = (value: CommercialFactLine, index: number): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidStockReference(`Sale line ${index} is invalid`)
  return value
}

const positiveQuantityOf = (line: Record<string, unknown>, index: number): number => {
  const hasQuantity = line.quantity !== undefined
  const hasCantidad = line.cantidad !== undefined
  if (!hasQuantity && !hasCantidad) throw invalidStockReference(`Sale line ${index} quantity is required`)
  const quantity = hasQuantity ? line.quantity : line.cantidad
  const cantidad = hasCantidad ? line.cantidad : quantity
  if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity <= 0 || typeof cantidad !== 'number' || !Number.isSafeInteger(cantidad) || cantidad <= 0 || quantity !== cantidad) {
    throw invalidStockReference(`Sale line ${index} quantity must be a positive integer`)
  }
  return quantity
}

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/

const sourceLineIdOf = (line: Record<string, unknown>, saleId: string, index: number): string => {
  const lineId = line.lineId === undefined ? undefined : identifierOf(line.lineId, `Sale line ${index} lineId`)
  if (lineId !== undefined && OBJECT_ID_PATTERN.test(lineId)) return lineId
  const lineIdentity = lineId ?? 'missing'
  return createHash('sha256')
    .update(`stock-source-line:v1:${saleId}:${lineIdentity}:${index}`, 'utf8')
    .digest('hex')
    .slice(0, 24)
}

const civilDateOf = (date: Date): string => {
  if (Number.isNaN(date.getTime())) throw invalidStockReference('businessDate is invalid')
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: STOCK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)
  const year = parts.find(({ type }) => type === 'year')?.value
  const month = parts.find(({ type }) => type === 'month')?.value
  const day = parts.find(({ type }) => type === 'day')?.value
  if (year === undefined || month === undefined || day === undefined) throw invalidStockReference('businessDate could not be normalized')
  return `${year}-${month}-${day}`
}

export const buenosAiresCivilDate = (date: Date = new Date()): string => civilDateOf(date)

const businessDateOf = (source: CommercialFact | StockSaleReference): string => {
  const explicit = source.businessDate
  if (typeof explicit === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(explicit)) throw invalidStockReference('businessDate must be a civil date')
    return explicit
  }
  if (explicit instanceof Date) return civilDateOf(explicit)
  return buenosAiresCivilDate()
}

const sourceLinesOf = (source: CommercialFact | StockSaleReference): CommercialFactLine[] => {
  if (!Array.isArray(source.lines) || source.lines.length === 0) throw invalidStockReference('At least one sale line is required')
  return source.lines
}

const productIdOf = (line: Record<string, unknown>, index: number): string => {
  const productValue = line.productId ?? line.idProducto ?? line._id
  return identifierOf(productValue, `Sale line ${index} productId`)
}

const purchaseLineIdentityOf = (line: Record<string, unknown>, buyId: string, index: number): string => {
  const value = line.itemBuyId ?? line.idItemBuy ?? line.lineId ?? line._id
  const identity = identifierOf(value, `Purchase line ${index} itemBuyId`)
  if (OBJECT_ID_PATTERN.test(identity)) return identity
  return createHash('sha256')
    .update(`stock-purchase-source-line:v1:${buyId}:${identity}`, 'utf8')
    .digest('hex')
    .slice(0, 24)
}

const purchaseQuantityOf = (line: Record<string, unknown>, index: number): number => {
  const values = [line.quantityReceived, line.quantity, line.cantidad].filter((value) => value !== undefined)
  if (values.length === 0 || values.some((value) => typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)) {
    throw invalidStockReference(`Purchase line ${index} quantity must be a positive integer`)
  }
  const quantity = values[0] as number
  if (values.some((value) => value !== quantity)) throw invalidStockReference(`Purchase line ${index} quantity aliases conflict`)
  return quantity
}

export const mapPurchaseReceiptToStockInput = (source: CommercialFact): PurchaseReceiptInput => {
  const buyId = identifierOf(source.aggregateId, 'buyId')
  const actorId = identifierOf(source.actorId, 'actorId')
  const lines = sourceLinesOf(source).map((entry, index) => {
    const line = lineRecordOf(entry, index)
    const expiryDate = line.expiryDate
    if (expiryDate !== undefined && typeof expiryDate !== 'string') throw invalidStockReference(`Purchase line ${index} expiryDate is invalid`)
    return {
      itemBuyId: purchaseLineIdentityOf(line, buyId, index),
      productId: productIdOf(line, index),
      quantityReceived: purchaseQuantityOf(line, index),
      ...(expiryDate === undefined ? {} : { expiryDate })
    }
  })
  return {
    buyId,
    lines,
    receivedAt: source.businessDate.toISOString(),
    businessDate: businessDateOf(source),
    operationId: source.idempotencyKey,
    receivedBy: actorId
  }
}

export const mapSaleReferenceToStockCommitInput = (source: CommercialFact | StockSaleReference): StockSaleCommitInput => {
  const sourceSaleId = 'aggregateId' in source ? source.aggregateId : source.saleId
  const saleId = identifierOf(sourceSaleId, 'saleId')
  const actorId = identifierOf(source.actorId, 'actorId')
  const explicitOperationId = 'operationId' in source ? source.operationId : undefined
  const sourceIdempotencyKey = 'idempotencyKey' in source ? source.idempotencyKey : undefined
  const operationId = typeof explicitOperationId === 'string' && explicitOperationId.trim() !== ''
    ? explicitOperationId.trim()
    : typeof sourceIdempotencyKey === 'string' && sourceIdempotencyKey.trim() !== ''
      ? sourceIdempotencyKey.trim()
      : `sale-commit:${saleId}`
  const lines = sourceLinesOf(source).map((entry, index) => {
    const line = lineRecordOf(entry, index)
    return {
      lineId: sourceLineIdOf(line, saleId, index),
      productId: productIdOf(line, index),
      quantity: positiveQuantityOf(line, index)
    }
  })
  return {
    saleId,
    operationId,
    businessDate: businessDateOf(source),
    auth: { actorId, canManageStock: false },
    lines
  }
}

export const stockPortAdapter: StockPort = {
  async commitSale (source: CommercialFact | StockSaleReference): Promise<void> {
    await stockService.commitSale(mapSaleReferenceToStockCommitInput(source))
  },
  async receivePurchase (source: CommercialFact): Promise<void> {
    await stockService.receivePurchase(mapPurchaseReceiptToStockInput(source))
  },
  async applyPurchaseAdjustment (): Promise<void> {},
  async applyPhysicalReturn (): Promise<void> {}
}

export const deliveryPortAdapter: DeliveryPort = {
  async recordSaleDelivery (fact: CommercialFact): Promise<void> {
    const input: SaleDeliveryInput = {
      saleId: identifierOf(fact.aggregateId, 'saleId'),
      deliveredAt: fact.businessDate.toISOString(),
      businessDate: businessDateOf(fact),
      operationId: fact.idempotencyKey,
      deliveredBy: identifierOf(fact.actorId, 'actorId')
    }
    await stockService.deliverSale(input)
    await SaleModel.updateOne(
      { _id: new Types.ObjectId(fact.aggregateId) },
      { $set: { delivery: { status: 'DELIVERED', deliveredAt: fact.businessDate } } }
    )
    await recomputeForSale(fact.aggregateId, fact.actorId)
  }
}

// Commitment reference handed from the sale-creation path to Stock. It carries
// only the sale identity, its line info and the acting user; it is a plain
// object, not a persisted CommercialFact, and the adapter must not write any
// business collection from it.
export interface SaleCommitmentReference {
  saleId: string
  lines: Array<Record<string, unknown>>
  actorId: string
  operationId?: string
  businessDate?: string
}

export interface SaleCancellationReference {
  saleId: string
  operationId: string
  businessDate: string
  actorId: string
}

// Centralizes the sale-creation wiring's commitment call so the caller never
// fabricates a full CommercialFact for a reservation that is not a fact.
export const commitSaleReference = async (commitment: SaleCommitmentReference): Promise<void> => {
  await stockPortAdapter.commitSale(commitment)
}

export const cancelSaleReference = async (cancellation: SaleCancellationReference): Promise<void> => {
  await stockService.cancelSale({
    saleId: cancellation.saleId,
    operationId: cancellation.operationId,
    businessDate: cancellation.businessDate,
    auth: { actorId: cancellation.actorId, canManageStock: false }
  })
}

// Phase 0 contract double for the Rutas saved-plan reader. It reads only from an
// explicitly provided, frozen registry and returns plans read-only. It never
// writes business collections and does not implement the Rutas planner.
export class RoutePlanReaderDouble implements RoutePlanReader {
  private readonly plans: Map<string, unknown>

  constructor (seedPlans: Record<string, unknown> = {}) {
    this.plans = new Map(Object.entries(seedPlans))
  }

  async readSavedPlan (planId: string): Promise<unknown> {
    const plan = this.plans.get(planId)
    if (plan === undefined) {
      throw new CommercialFactError('FEATURE_UNAVAILABLE', 'Saved plan is not available')
    }
    return Object.freeze(plan)
  }
}

// Allowed producer snapshot versions for the read-only simulation contract. The
// exact producer field schemas are owned by the Rutas and Stock modules and are
// deferred; this guard only enforces version compatibility and presence of
// mandatory data, and it never writes to any producer collection or port.
const SUPPORTED_SNAPSHOT_VERSIONS = new Set<string>([
  'SIM-ROUTE-SNAPSHOT-001',
  'SIM-STOCK-SNAPSHOT-001'
])

export const assertSimulationSnapshotCompatible = (snapshot: unknown): void => {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new CommercialFactError('SIMULATION_CONTRACT_INCOMPATIBLE', 'Simulation snapshot is not a valid object')
  }

  const record = snapshot as Record<string, unknown>
  const version = record.version

  if (typeof version !== 'string' || !SUPPORTED_SNAPSHOT_VERSIONS.has(version)) {
    throw new CommercialFactError('SIMULATION_CONTRACT_INCOMPATIBLE', 'Simulation snapshot version is not supported')
  }

  if (record.data === undefined || record.data === null) {
    throw new CommercialFactError('SIMULATION_CONTRACT_INCOMPATIBLE', 'Simulation snapshot is missing mandatory data')
  }
}
