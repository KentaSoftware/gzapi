import { createHash } from 'crypto'
import { Types } from 'mongoose'
import BuyModel from '../models/buy'
import CommercialFactModel from '../models/commercialFact'
import ItemBuyModel from '../models/itemBuy'
import SaleModel from '../models/sale'
import {
  CommercialFact,
  CommercialFactError,
  CommercialFactInput,
  CommercialFactLine,
  CommercialFactRequestContext,
  CommercialFactResult,
  CommercialFactType,
  FinancePort,
  StockPort
} from '../interfaces/commercialFact.interface'
import { financePortAdapter, stockPortAdapter } from './commercialPorts'

const stableStringify = (value: unknown): string => {
  if (value === null || value === undefined) return 'null'
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const hashCanonicalPayload = (type: CommercialFactType, input: CommercialFactInput): string => {
  const payload: Record<string, unknown> = {
    type,
    aggregateId: input.aggregateId,
    businessDate: input.businessDate.toISOString()
  }
  if (input.amount !== undefined) payload.amount = input.amount
  if (input.reason !== undefined) payload.reason = input.reason
  if (input.lines !== undefined) payload.lines = input.lines
  if (input.sourceFactId !== undefined) payload.sourceFactId = input.sourceFactId
  return createHash('sha256').update(stableStringify(payload)).digest('hex')
}

const sumLineQuantities = (lines: CommercialFactLine[]): number =>
  lines.reduce((total, line) => {
    const quantity = line.quantity
    return total + (typeof quantity === 'number' ? quantity : 0)
  }, 0)

// A concurrent request with the same idempotency key can win the unique
// index race: recognize the raw duplicate-key error to fall back to the
// recorded fact's replay semantics instead of leaking it.
const isDuplicateKeyError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown, message?: unknown }
  return candidate.code === 11000 ||
    (typeof candidate.message === 'string' && candidate.message.includes('E11000'))
}

interface ExecuteParams {
  type: CommercialFactType
  aggregateType: 'sale' | 'buy'
  input: CommercialFactInput
  ctx: CommercialFactRequestContext
  amount?: number
  resolveAmount?: () => number | undefined
  sourceReference: string
  validate: () => Promise<void>
  notify?: (fact: CommercialFact) => Promise<void>
}

export class CommercialFactService {
  private readonly financePort: FinancePort
  private readonly stockPort: StockPort

  constructor (ports?: { financePort?: FinancePort, stockPort?: StockPort }) {
    this.financePort = ports?.financePort ?? financePortAdapter
    this.stockPort = ports?.stockPort ?? stockPortAdapter
  }

  private async execute (params: ExecuteParams): Promise<CommercialFactResult> {
    const { type, input, ctx } = params
    const payloadHash = hashCanonicalPayload(type, input)

    const existing = await CommercialFactModel.findOne({
      type,
      aggregateId: input.aggregateId,
      idempotencyKey: input.idempotencyKey
    }).lean()

    if (existing !== null) {
      if (existing.payloadHash !== payloadHash) {
        throw new CommercialFactError('IDEMPOTENCY_KEY_CONFLICT', 'idempotencyKey was already used with a different payload')
      }
      return await this.replayExisting(params, existing as unknown as CommercialFact)
    }

    await params.validate()
    const amount = params.resolveAmount !== undefined ? params.resolveAmount() : params.amount

    let document
    try {
      document = await CommercialFactModel.create({
        type,
        aggregateType: params.aggregateType,
        aggregateId: input.aggregateId,
        amount,
        businessDate: input.businessDate,
        actorId: ctx.actorId,
        sourceReference: params.sourceReference,
        correlationId: ctx.correlationId,
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        reason: input.reason,
        lines: input.lines,
        status: 'PENDING'
      })
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        const raced = await CommercialFactModel.findOne({
          type,
          aggregateId: input.aggregateId,
          idempotencyKey: input.idempotencyKey
        }).lean()
        if (raced !== null && raced.payloadHash === payloadHash) {
          return await this.replayExisting(params, raced as unknown as CommercialFact)
        }
        if (raced !== null) {
          throw new CommercialFactError('IDEMPOTENCY_KEY_CONFLICT', 'idempotencyKey was already used with a different payload')
        }
      }
      throw error
    }

    const fact = document.toObject() as unknown as CommercialFact

    try {
      if (params.notify !== undefined) {
        await params.notify(fact)
      }
    } catch (portError) {
      await CommercialFactModel.updateOne({ _id: fact._id }, { status: 'FAILED_RECOVERABLE' })
      throw portError
    }

    await CommercialFactModel.updateOne({ _id: fact._id }, { status: 'APPLIED' })
    fact.status = 'APPLIED'
    return { fact, replayed: false }
  }

  // A replayed key must observe its original result; when the first attempt
  // never completed its side effects, the recoverable registry re-applies
  // them before answering so the recorded fact and its projections agree.
  private async replayExisting (params: ExecuteParams, fact: CommercialFact): Promise<CommercialFactResult> {
    if (fact.status !== 'APPLIED') {
      if (params.notify !== undefined) {
        await params.notify(fact)
      }
      await CommercialFactModel.updateOne({ _id: fact._id }, { status: 'APPLIED' })
      fact.status = 'APPLIED'
    }
    return { fact, replayed: true }
  }

  async confirmSalePayment (
    input: CommercialFactInput,
    ctx: CommercialFactRequestContext,
    options?: { accessible?: boolean }
  ): Promise<CommercialFactResult> {
    let saleTotal: number | undefined

    return await this.execute({
      type: 'SALE_PAYMENT',
      aggregateType: 'sale',
      input,
      ctx,
      resolveAmount: () => saleTotal,
      sourceReference: `sale:${input.aggregateId}`,
      validate: async () => {
        const sale = await SaleModel.findById(input.aggregateId).lean()
        if (sale === null) {
          throw new CommercialFactError('SALE_PAYMENT_FORBIDDEN', 'Sale is not accessible')
        }
        if (options?.accessible === false) {
          throw new CommercialFactError('SALE_PAYMENT_FORBIDDEN', 'Caller lacks access to this sale')
        }
        const prior = await CommercialFactModel.findOne({ type: 'SALE_PAYMENT', aggregateId: input.aggregateId }).lean()
        if (prior !== null) {
          throw new CommercialFactError('SALE_ALREADY_PAID', 'Sale already has a confirmed payment')
        }
        saleTotal = sale.total
      },
      notify: async (fact) => { await this.financePort.recordSalePayment(fact) }
    })
  }

  async recordSaleRefund (
    input: CommercialFactInput,
    ctx: CommercialFactRequestContext
  ): Promise<CommercialFactResult> {
    const payment = await CommercialFactModel.findOne({ type: 'SALE_PAYMENT', aggregateId: input.aggregateId }).lean()
    const refunds = await CommercialFactModel.find({ type: 'SALE_REFUND', aggregateId: input.aggregateId }).lean()
    const collected = payment === null ? 0 : (typeof payment.amount === 'number' ? payment.amount : 0)
    const refundedSoFar = refunds.reduce((total, refund) => total + (typeof refund.amount === 'number' ? refund.amount : 0), 0)
    const amount = input.amount

    return await this.execute({
      type: 'SALE_REFUND',
      aggregateType: 'sale',
      input,
      ctx,
      amount,
      sourceReference: `sale:${input.aggregateId}`,
      validate: async () => {
        if (payment === null || amount === undefined || amount <= 0 || refundedSoFar + amount > collected) {
          throw new CommercialFactError('REFUND_EXCEEDS_COLLECTED', 'Refund would exceed the collected amount for this sale')
        }
      },
      notify: async (fact) => { await this.financePort.recordSaleRefund(fact) }
    })
  }

  async confirmPurchasePayment (
    input: CommercialFactInput,
    ctx: CommercialFactRequestContext
  ): Promise<CommercialFactResult> {
    let buyTotal: number | undefined

    return await this.execute({
      type: 'PURCHASE_PAYMENT',
      aggregateType: 'buy',
      input,
      ctx,
      resolveAmount: () => buyTotal,
      sourceReference: `buy:${input.aggregateId}`,
      validate: async () => {
        const buy = await BuyModel.findById(input.aggregateId).lean()
        const prior = await CommercialFactModel.findOne({ type: 'PURCHASE_PAYMENT', aggregateId: input.aggregateId }).lean()
        if (buy === null || prior !== null) {
          throw new CommercialFactError('PURCHASE_ALREADY_PAID', 'Purchase does not exist or is already paid')
        }
        buyTotal = Number(buy.total)
      },
      notify: async (fact) => { await this.financePort.recordPurchasePayment(fact) }
    })
  }

  async receivePurchase (
    input: CommercialFactInput,
    ctx: CommercialFactRequestContext
  ): Promise<CommercialFactResult> {
    const buy = await BuyModel.findById(input.aggregateId).lean()
    const prior = await CommercialFactModel.findOne({ type: 'PURCHASE_RECEIPT', aggregateId: input.aggregateId }).lean()
    const items = await ItemBuyModel.find({ idBuy: new Types.ObjectId(input.aggregateId) }).lean()
    const expectedQuantity = items.reduce((total, item) => total + (typeof item.cantidad === 'number' ? item.cantidad : 0), 0)
    const receivedQuantity = input.lines === undefined ? 0 : sumLineQuantities(input.lines)

    return await this.execute({
      type: 'PURCHASE_RECEIPT',
      aggregateType: 'buy',
      input,
      ctx,
      sourceReference: `buy:${input.aggregateId}`,
      validate: async () => {
        if (buy === null) {
          throw new CommercialFactError('PURCHASE_ALREADY_RECEIVED', 'Purchase does not exist or is already received')
        }
        if (prior !== null) {
          throw new CommercialFactError('PURCHASE_ALREADY_RECEIVED', 'Purchase is already fully received')
        }
        if (receivedQuantity !== expectedQuantity) {
          throw new CommercialFactError('PURCHASE_PARTIAL_RECEIPT_UNSUPPORTED', 'Only complete purchases can be received in this phase')
        }
      },
      notify: async (fact) => { await this.stockPort.receivePurchase(fact) }
    })
  }

  async applyPurchaseAdjustment (
    input: CommercialFactInput,
    ctx: CommercialFactRequestContext
  ): Promise<CommercialFactResult> {
    const sourceFactId = input.sourceFactId
    const sourceFact = sourceFactId === undefined
      ? null
      : await CommercialFactModel.findById(sourceFactId).lean()

    return await this.execute({
      type: 'PURCHASE_ADJUSTMENT',
      aggregateType: 'buy',
      input,
      ctx,
      sourceReference: `PURCHASE_RECEIPT:${sourceFactId ?? ''}`,
      validate: async () => {
        if (sourceFact === null || sourceFact.type !== 'PURCHASE_RECEIPT' || sourceFact.aggregateId !== input.aggregateId) {
          throw new CommercialFactError('PURCHASE_ADJUSTMENT_INVALID', 'Adjustment must reference a valid receipt of the same purchase')
        }
      },
      notify: async (fact) => { await this.stockPort.applyPurchaseAdjustment(fact) }
    })
  }

  async recordSaleDelivery (
    input: CommercialFactInput,
    ctx: CommercialFactRequestContext
  ): Promise<CommercialFactResult> {
    const sale = await SaleModel.findById(input.aggregateId).lean()
    const cancellation = await CommercialFactModel.findOne({ type: 'SALE_CANCELLATION', aggregateId: input.aggregateId }).lean()

    return await this.execute({
      type: 'SALE_DELIVERY',
      aggregateType: 'sale',
      input,
      ctx,
      sourceReference: `sale:${input.aggregateId}`,
      validate: async () => {
        const cancelled = sale === null || sale.estado === 'Cancelado' || cancellation !== null
        if (cancelled) {
          throw new CommercialFactError('SALE_DELIVERY_INVALID', 'Sale is not registered or is already cancelled')
        }
      }
    })
  }

  async recordSaleCancellation (
    input: CommercialFactInput,
    ctx: CommercialFactRequestContext
  ): Promise<CommercialFactResult> {
    const sale = await SaleModel.findById(input.aggregateId).lean()
    const priorCancellation = await CommercialFactModel.findOne({ type: 'SALE_CANCELLATION', aggregateId: input.aggregateId }).lean()

    return await this.execute({
      type: 'SALE_CANCELLATION',
      aggregateType: 'sale',
      input,
      ctx,
      sourceReference: `sale:${input.aggregateId}`,
      validate: async () => {
        const cancelled = sale === null || sale.estado === 'Cancelado' || priorCancellation !== null
        if (cancelled) {
          throw new CommercialFactError('SALE_CANCELLATION_INVALID', 'Sale is not registered or is already cancelled')
        }
      }
    })
  }

  async applyPhysicalReturn (
    input: CommercialFactInput,
    ctx: CommercialFactRequestContext
  ): Promise<CommercialFactResult> {
    const sale = await SaleModel.findById(input.aggregateId).lean()
    const delivery = await CommercialFactModel.findOne({ type: 'SALE_DELIVERY', aggregateId: input.aggregateId }).lean()

    return await this.execute({
      type: 'SALE_PHYSICAL_RETURN',
      aggregateType: 'sale',
      input,
      ctx,
      sourceReference: `sale:${input.aggregateId}`,
      validate: async () => {
        if (sale === null || delivery === null) {
          throw new CommercialFactError('SALE_PHYSICAL_RETURN_INVALID', 'Sale must be delivered before a physical return')
        }
      },
      notify: async (fact) => { await this.stockPort.applyPhysicalReturn(fact) }
    })
  }
}
