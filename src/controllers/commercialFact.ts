import { NextFunction, Request, Response } from 'express'
import { Types } from 'mongoose'
import { CommercialFactService } from '../services/commercialFact'
import {
  CommercialFactError,
  CommercialFactInput,
  CommercialFactLine,
  CommercialFactRequestContext,
  CommercialErrorCode
} from '../interfaces/commercialFact.interface'
import { sendErrorEnvelope } from '../utils/error.handle'
import { isPhase0ContractsEnabled } from '../config/phase0'
import { getSale } from '../services/sale'

interface AuthenticatedUser {
  id?: string
  role?: {
    name?: string
    permissions?: string[]
  }
}

interface RequestExt extends Request {
  user?: AuthenticatedUser
}

interface ValidatedBody {
  date: Date
  body: Record<string, unknown>
}

const service = new CommercialFactService()

const correlationOf = (req: Request): string | undefined => {
  const header = req.headers['x-correlation-id']
  return typeof header === 'string' && header !== '' ? header : undefined
}

// Maps a stable commercial error code to its HTTP status (plan §9). Transition
// and idempotency conflicts are 409; ownership/permission denials are 403; the
// unclassified remainder is 500.
const statusFor = (code: CommercialErrorCode): number => {
  switch (code) {
    case 'SALE_PAYMENT_FORBIDDEN':
    case 'PERMISSION_DENIED':
      return 403
    case 'SALE_ALREADY_PAID':
    case 'SALE_DELIVERY_INVALID':
    case 'SALE_CANCELLATION_INVALID':
    case 'SALE_PHYSICAL_RETURN_INVALID':
    case 'REFUND_EXCEEDS_COLLECTED':
    case 'PURCHASE_ALREADY_PAID':
    case 'PURCHASE_PARTIAL_RECEIPT_UNSUPPORTED':
    case 'PURCHASE_ALREADY_RECEIVED':
    case 'PURCHASE_ADJUSTMENT_INVALID':
    case 'IDEMPOTENCY_KEY_CONFLICT':
      return 409
    case 'FEATURE_UNAVAILABLE':
      return 503
    default:
      return 500
  }
}

const isCommercialFactError = (error: unknown): error is CommercialFactError =>
  typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'

const handleError = (res: Response, correlationId: string | undefined, error: unknown): void => {
  if (isCommercialFactError(error)) {
    sendErrorEnvelope(res, statusFor(error.code), error.code, error.message, correlationId)
    return
  }
  sendErrorEnvelope(res, 500, 'INTERNAL_ERROR', 'Unclassified error', correlationId)
}

const requireContractsEnabled = (req: Request, res: Response, next: NextFunction): void => {
  if (!isPhase0ContractsEnabled()) {
    sendErrorEnvelope(res, 503, 'FEATURE_UNAVAILABLE', 'Commercial fact contracts are disabled in this phase', correlationOf(req))
    return
  }
  next()
}

const actorIdOf = (user: AuthenticatedUser | undefined): string => String(user?.id ?? '')

const contextOf = (user: AuthenticatedUser | undefined, correlationId: string | undefined): CommercialFactRequestContext => ({
  actorId: actorIdOf(user),
  correlationId
})

const roleNameOf = (user: AuthenticatedUser | undefined): string | undefined => user?.role?.name

// FR-041/FR-042: Propietario/Administración may act on any sale; a Preventista
// may only act on a sale they created.
const computeAccessible = (user: AuthenticatedUser | undefined, saleUser: unknown): boolean => {
  const roleName = roleNameOf(user)
  if (roleName === 'Propietario' || roleName === 'Administración') return true
  if (saleUser === null || saleUser === undefined) return false
  return String(saleUser) === String(user?.id ?? '')
}

const missingFields = (body: Record<string, unknown>, fields: string[]): string[] =>
  fields.filter((field) => body[field] === undefined || body[field] === null || body[field] === '')

const validateBody = (res: Response, correlationId: string | undefined, body: Record<string, unknown>, fields: string[]): ValidatedBody | undefined => {
  const missing = missingFields(body, fields)
  if (missing.length > 0) {
    sendErrorEnvelope(res, 400, 'INVALID_PAYLOAD', `Missing required fields: ${missing.join(', ')}`, correlationId)
    return undefined
  }
  if (typeof body.businessDate !== 'string') {
    sendErrorEnvelope(res, 400, 'INVALID_PAYLOAD', 'businessDate must be a string', correlationId)
    return undefined
  }
  const date = new Date(body.businessDate)
  if (Number.isNaN(date.getTime())) {
    sendErrorEnvelope(res, 400, 'INVALID_PAYLOAD', 'businessDate must be a valid date', correlationId)
    return undefined
  }
  return { date, body }
}

const requireLines = (res: Response, correlationId: string | undefined, body: Record<string, unknown>): boolean => {
  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    sendErrorEnvelope(res, 400, 'INVALID_PAYLOAD', 'lines must be a non-empty array', correlationId)
    return false
  }
  return true
}

const buildInput = (aggregateId: string, body: Record<string, unknown>, businessDate: Date): CommercialFactInput => {
  const input: CommercialFactInput = {
    aggregateId,
    businessDate,
    idempotencyKey: String(body.idempotencyKey)
  }
  if (body.reason !== undefined) input.reason = String(body.reason)
  if (body.amount !== undefined) input.amount = Number(body.amount)
  if (body.lines !== undefined) input.lines = body.lines as CommercialFactLine[]
  if (body.sourceFactId !== undefined) input.sourceFactId = String(body.sourceFactId)
  return input
}

const respond = (res: Response, result: { replayed: boolean }): void => {
  res.status(result.replayed ? 200 : 201).send(result)
}

const confirmSalePayment = async (req: RequestExt, res: Response): Promise<void> => {
  const correlationId = correlationOf(req)
  const body = req.body as Record<string, unknown>
  const saleId = req.params.saleId

  const validated = validateBody(res, correlationId, body, ['businessDate', 'idempotencyKey'])
  if (validated === undefined) return

  const [sale] = await getSale(new Types.ObjectId(saleId))
  const accessible = computeAccessible(req.user, sale === undefined ? undefined : sale.user)

  try {
    const result = await service.confirmSalePayment(
      buildInput(saleId, validated.body, validated.date),
      contextOf(req.user, correlationId),
      { accessible }
    )
    respond(res, result)
  } catch (error) {
    handleError(res, correlationId, error)
  }
}

const recordSaleRefund = async (req: RequestExt, res: Response): Promise<void> => {
  const correlationId = correlationOf(req)
  const body = req.body as Record<string, unknown>
  const saleId = req.params.saleId

  const validated = validateBody(res, correlationId, body, ['amount', 'businessDate', 'reason', 'idempotencyKey'])
  if (validated === undefined) return

  if (typeof body.amount !== 'number' || body.amount <= 0) {
    sendErrorEnvelope(res, 400, 'INVALID_PAYLOAD', 'amount must be a positive number', correlationId)
    return
  }

  try {
    const result = await service.recordSaleRefund(
      buildInput(saleId, validated.body, validated.date),
      contextOf(req.user, correlationId)
    )
    respond(res, result)
  } catch (error) {
    handleError(res, correlationId, error)
  }
}

const confirmPurchasePayment = async (req: RequestExt, res: Response): Promise<void> => {
  const correlationId = correlationOf(req)
  const body = req.body as Record<string, unknown>
  const buyId = req.params.buyId

  const validated = validateBody(res, correlationId, body, ['businessDate', 'idempotencyKey'])
  if (validated === undefined) return

  try {
    const result = await service.confirmPurchasePayment(
      buildInput(buyId, validated.body, validated.date),
      contextOf(req.user, correlationId)
    )
    respond(res, result)
  } catch (error) {
    handleError(res, correlationId, error)
  }
}

const receivePurchase = async (req: RequestExt, res: Response): Promise<void> => {
  const correlationId = correlationOf(req)
  const body = req.body as Record<string, unknown>
  const buyId = req.params.buyId

  const validated = validateBody(res, correlationId, body, ['lines', 'businessDate', 'idempotencyKey'])
  if (validated === undefined) return
  if (!requireLines(res, correlationId, body)) return

  try {
    const result = await service.receivePurchase(
      buildInput(buyId, validated.body, validated.date),
      contextOf(req.user, correlationId)
    )
    respond(res, result)
  } catch (error) {
    handleError(res, correlationId, error)
  }
}

const applyPurchaseAdjustment = async (req: RequestExt, res: Response): Promise<void> => {
  const correlationId = correlationOf(req)
  const body = req.body as Record<string, unknown>
  const buyId = req.params.buyId

  const validated = validateBody(res, correlationId, body, ['sourceFactId', 'lines', 'reason', 'businessDate', 'idempotencyKey'])
  if (validated === undefined) return
  if (!requireLines(res, correlationId, body)) return

  try {
    const result = await service.applyPurchaseAdjustment(
      buildInput(buyId, validated.body, validated.date),
      contextOf(req.user, correlationId)
    )
    respond(res, result)
  } catch (error) {
    handleError(res, correlationId, error)
  }
}

const recordSaleDelivery = async (req: RequestExt, res: Response): Promise<void> => {
  const correlationId = correlationOf(req)
  const body = req.body as Record<string, unknown>
  const saleId = req.params.saleId

  const validated = validateBody(res, correlationId, body, ['businessDate', 'idempotencyKey'])
  if (validated === undefined) return

  const [sale] = await getSale(new Types.ObjectId(saleId))
  const accessible = computeAccessible(req.user, sale === undefined ? undefined : sale.user)
  if (!accessible) {
    sendErrorEnvelope(res, 403, 'SALE_PAYMENT_FORBIDDEN', 'Caller lacks access to this sale', correlationId)
    return
  }

  try {
    const result = await service.recordSaleDelivery(
      buildInput(saleId, validated.body, validated.date),
      contextOf(req.user, correlationId)
    )
    respond(res, result)
  } catch (error) {
    handleError(res, correlationId, error)
  }
}

const recordSaleCancellation = async (req: RequestExt, res: Response): Promise<void> => {
  const correlationId = correlationOf(req)
  const body = req.body as Record<string, unknown>
  const saleId = req.params.saleId

  const validated = validateBody(res, correlationId, body, ['businessDate', 'idempotencyKey'])
  if (validated === undefined) return

  const [sale] = await getSale(new Types.ObjectId(saleId))
  const accessible = computeAccessible(req.user, sale === undefined ? undefined : sale.user)
  if (!accessible) {
    sendErrorEnvelope(res, 403, 'SALE_PAYMENT_FORBIDDEN', 'Caller lacks access to this sale', correlationId)
    return
  }

  try {
    const result = await service.recordSaleCancellation(
      buildInput(saleId, validated.body, validated.date),
      contextOf(req.user, correlationId)
    )
    respond(res, result)
  } catch (error) {
    handleError(res, correlationId, error)
  }
}

const applyPhysicalReturn = async (req: RequestExt, res: Response): Promise<void> => {
  const correlationId = correlationOf(req)
  const body = req.body as Record<string, unknown>
  const saleId = req.params.saleId

  const validated = validateBody(res, correlationId, body, ['lines', 'businessDate', 'idempotencyKey'])
  if (validated === undefined) return
  if (!requireLines(res, correlationId, body)) return

  try {
    const result = await service.applyPhysicalReturn(
      buildInput(saleId, validated.body, validated.date),
      contextOf(req.user, correlationId)
    )
    respond(res, result)
  } catch (error) {
    handleError(res, correlationId, error)
  }
}

export {
  requireContractsEnabled,
  confirmSalePayment,
  recordSaleRefund,
  confirmPurchasePayment,
  receivePurchase,
  applyPurchaseAdjustment,
  recordSaleDelivery,
  recordSaleCancellation,
  applyPhysicalReturn
}
