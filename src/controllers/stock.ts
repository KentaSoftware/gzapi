import { Request, Response } from 'express'

import {
  STOCK_ERROR_CODES,
  STOCK_OPERATION_STATUSES,
  type ExpiredRemovalInput,
  type OpeningCountConfirmationInput,
  type OpeningCountInput,
  type OpeningCountWriter,
  type PurchaseReceiptInput,
  type StockAvailabilityQuery,
  type StockOverviewQuery,
  type StockProductDetailQuery,
  type StockOperationResult,
  type StockPhysicalReturnInput,
  type StockServiceAuth
} from '../interfaces/stock.interface'
import {
  availabilityQuerySchema,
  expiredRemovalInputSchema,
  objectIdSchema,
  purchaseReceiptInputSchema,
  stockMinimumUpdateSchema,
  stockOverviewQuerySchema,
  stockProductDetailQuerySchema,
  stockReturnInputSchema
} from '../schemas/stock.schema'
import { StockService, StockServiceError } from '../services/stock'
import { confirmOpeningCount, OpeningCountError, previewOpeningCount } from '../services/stockOpening'
import { createMongooseStockRepository } from '../services/stockMongoRepository'
import { createOpeningCountWriter } from '../services/stockOpeningWriter'
import { STOCK_TIME_ZONE } from '../config/stock'
import { sendErrorEnvelope } from '../utils/error.handle'

interface RequestExt extends Request {
}

const HTTP_STATUS = {
  CREATED: 201,
  OK: 200,
  BAD_REQUEST: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_SERVER_ERROR: 500
} as const

const STOCK_ERROR_MESSAGES = {
  STOCK_FORBIDDEN: 'Stock permission is required',
  STOCK_DATA_INCOMPLETE: 'Stock request data is incomplete or invalid',
  STOCK_PRODUCT_NOT_FOUND: 'Stock product was not found',
  STOCK_INSUFFICIENT: 'Stock is insufficient for this operation',
  STOCK_AVAILABILITY_UNAVAILABLE: 'Stock availability is currently unavailable',
  EXPIRED_BUCKET_HAS_COMMITMENTS: 'The expired bucket still has sale commitments',
  STOCK_BASELINE_ALREADY_RECONCILED: 'The product baseline has already been reconciled',
  STOCK_BUCKET_HAS_COMMITMENTS: 'The stock bucket still has sale commitments',
  STOCK_IDEMPOTENCY_CONFLICT: 'Stock operation conflicts with an existing idempotency record',
  STOCK_REPOSITORY_ERROR: 'Stock persistence is currently unavailable'
} as const

type StockErrorCode = keyof typeof STOCK_ERROR_MESSAGES

const service = new StockService(createMongooseStockRepository())
const openingCountWriter = createOpeningCountWriter()

const correlationOf = (req: Request): string | undefined => {
  const header = req.headers?.['x-correlation-id']
  return typeof header === 'string' && header.trim() !== '' ? header : undefined
}

const actorIdOf = (res: Response): string => {
  const actorId = res.locals.userId
  return typeof actorId === 'string' ? actorId.trim() : ''
}

const authOf = (actorId: string): StockServiceAuth => ({ actorId, canManageStock: true })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const invalidPayload = (res: Response, correlationId: string | undefined): void => {
  sendErrorEnvelope(res, HTTP_STATUS.BAD_REQUEST, STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, STOCK_ERROR_MESSAGES.STOCK_DATA_INCOMPLETE, correlationId)
}

const requireActor = (res: Response, correlationId: string | undefined): string | undefined => {
  const actorId = actorIdOf(res)
  if (actorId === '') {
    sendErrorEnvelope(res, HTTP_STATUS.FORBIDDEN, STOCK_ERROR_CODES.STOCK_FORBIDDEN, STOCK_ERROR_MESSAGES.STOCK_FORBIDDEN, correlationId)
    return undefined
  }
  return actorId
}

const statusFor = (code: StockErrorCode): number => {
  switch (code) {
    case STOCK_ERROR_CODES.STOCK_FORBIDDEN:
      return HTTP_STATUS.FORBIDDEN
    case STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE:
      return HTTP_STATUS.BAD_REQUEST
    case STOCK_ERROR_CODES.STOCK_PRODUCT_NOT_FOUND:
      return HTTP_STATUS.NOT_FOUND
    case STOCK_ERROR_CODES.STOCK_INSUFFICIENT:
    case STOCK_ERROR_CODES.STOCK_BASELINE_ALREADY_RECONCILED:
    case STOCK_ERROR_CODES.STOCK_BUCKET_HAS_COMMITMENTS:
    case STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT:
    case STOCK_ERROR_CODES.EXPIRED_BUCKET_HAS_COMMITMENTS:
      return HTTP_STATUS.CONFLICT
    case STOCK_ERROR_CODES.STOCK_AVAILABILITY_UNAVAILABLE:
    case STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR:
      return HTTP_STATUS.SERVICE_UNAVAILABLE
  }
}

const isStockServiceError = (error: unknown): error is StockServiceError => error instanceof StockServiceError
const isOpeningCountError = (error: unknown): error is OpeningCountError => error instanceof OpeningCountError

const handleError = (res: Response, correlationId: string | undefined, error: unknown): void => {
  if (isStockServiceError(error) || isOpeningCountError(error)) {
    sendErrorEnvelope(res, statusFor(error.code), error.code, STOCK_ERROR_MESSAGES[error.code], correlationId)
    return
  }
  sendErrorEnvelope(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Stock operation failed', correlationId)
}

const respond = (res: Response, operation: StockOperationResult): void => {
  const status = operation.appliedMovementCount === 0 ? HTTP_STATUS.OK : HTTP_STATUS.CREATED
  res.status(status).send(operation)
}

const productIdsOf = (value: unknown): string[] | undefined => {
  const values = typeof value === 'string' ? [value] : Array.isArray(value) ? value : undefined
  if (values === undefined || !values.every((entry): entry is string => typeof entry === 'string')) return undefined
  return values.flatMap((entry) => entry.split(',').map((item) => item.trim())).filter((entry) => entry !== '')
}

const availabilityQueryOf = (query: Record<string, unknown>): Record<string, unknown> | undefined => {
  const productIds = productIdsOf(query.productIds)
  if (productIds === undefined) return undefined
  return { ...query, productIds }
}

const getAvailability = async (req: RequestExt, res: Response): Promise<void> => {
  const correlationId = correlationOf(req)
  const actorId = requireActor(res, correlationId)
  if (actorId === undefined) return

  const normalizedQuery = availabilityQueryOf(req.query as unknown as Record<string, unknown>)
  const parsed = normalizedQuery === undefined ? undefined : availabilityQuerySchema.safeParse(normalizedQuery)
  if (parsed === undefined || !parsed.success || parsed.data.businessDate === undefined) {
    invalidPayload(res, correlationId)
    return
  }

  const timeZone = parsed.data.timeZone ?? STOCK_TIME_ZONE
  const input: StockAvailabilityQuery = {
    ...parsed.data,
    businessDate: parsed.data.businessDate,
    timeZone,
    auth: authOf(actorId)
  }

  try {
    const availability = await service.getAvailability(input)
    res.status(HTTP_STATUS.OK).send(availability)
  } catch (error) {
    handleError(res, correlationId, error)
  }
}

const getOverview = async (req: RequestExt, res: Response): Promise<void> => {
  const correlationId = correlationOf(req)
  const actorId = requireActor(res, correlationId)
  if (actorId === undefined) return
  const parsed = stockOverviewQuerySchema.safeParse(req.query as unknown as Record<string, unknown>)
  if (!parsed.success) {
    invalidPayload(res, correlationId)
    return
  }
  const input: StockOverviewQuery = { ...parsed.data, auth: authOf(actorId) }
  try {
    res.status(HTTP_STATUS.OK).send(await service.getOverview(input))
  } catch (error) {
    handleError(res, correlationId, error)
  }
}

const getProductDetail = async (req: RequestExt, res: Response): Promise<void> => {
  const correlationId = correlationOf(req)
  const actorId = requireActor(res, correlationId)
  if (actorId === undefined) return
  const productId = objectIdSchema.safeParse(req.params.id)
  const parsed = stockProductDetailQuerySchema.safeParse(req.query as unknown as Record<string, unknown>)
  if (!productId.success || !parsed.success) {
    invalidPayload(res, correlationId)
    return
  }
  const input: StockProductDetailQuery = { ...parsed.data, productId: productId.data, auth: authOf(actorId) }
  try {
    res.status(HTTP_STATUS.OK).send(await service.getProductDetail(input))
  } catch (error) {
    handleError(res, correlationId, error)
  }
}

const updateMinimum = async (req: RequestExt, res: Response): Promise<void> => {
  const correlationId = correlationOf(req)
  const actorId = requireActor(res, correlationId)
  if (actorId === undefined || !isRecord(req.body)) {
    if (actorId !== undefined) invalidPayload(res, correlationId)
    return
  }
  const productId = objectIdSchema.safeParse(req.params.id)
  const parsed = stockMinimumUpdateSchema.safeParse(req.body)
  if (!productId.success || !parsed.success) {
    invalidPayload(res, correlationId)
    return
  }
  try {
    res.status(HTTP_STATUS.OK).send(await service.updateMinimum(productId.data, parsed.data.minimum, authOf(actorId), {
      correlationId,
      ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason })
    }))
  } catch (error) {
    handleError(res, correlationId, error)
  }
}

const receivePurchase = async (req: RequestExt, res: Response): Promise<void> => {
  const correlationId = correlationOf(req)
  const actorId = requireActor(res, correlationId)
  if (actorId === undefined || !isRecord(req.body)) {
    if (actorId !== undefined) invalidPayload(res, correlationId)
    return
  }

  const parsed = purchaseReceiptInputSchema.safeParse({
    ...req.body,
    buyId: req.params.buyId,
    receivedBy: actorId
  })
  if (!parsed.success) {
    invalidPayload(res, correlationId)
    return
  }

  try {
    const operation = await service.receivePurchase(parsed.data as PurchaseReceiptInput)
    respond(res, operation)
  } catch (error) {
    handleError(res, correlationId, error)
  }
}

const returnSale = async (req: RequestExt, res: Response): Promise<void> => {
  const correlationId = correlationOf(req)
  const actorId = requireActor(res, correlationId)
  if (actorId === undefined || !isRecord(req.body)) {
    if (actorId !== undefined) invalidPayload(res, correlationId)
    return
  }

  const parsed = stockReturnInputSchema.safeParse(req.body)
  if (!parsed.success) {
    invalidPayload(res, correlationId)
    return
  }

  const input: StockPhysicalReturnInput = {
    ...parsed.data,
    occurredAt: parsed.data.occurredAt === undefined ? undefined : new Date(parsed.data.occurredAt),
    auth: authOf(actorId)
  }

  try {
    const operation = await service.returnSale(input)
    respond(res, operation)
  } catch (error) {
    handleError(res, correlationId, error)
  }
}

const removeExpiredBucket = async (req: RequestExt, res: Response): Promise<void> => {
  const correlationId = correlationOf(req)
  const actorId = requireActor(res, correlationId)
  if (actorId === undefined || !isRecord(req.body)) {
    if (actorId !== undefined) invalidPayload(res, correlationId)
    return
  }

  const bucketId = objectIdSchema.safeParse(req.params.id)
  const parsed = expiredRemovalInputSchema.safeParse(req.body)
  if (!bucketId.success || !parsed.success) {
    invalidPayload(res, correlationId)
    return
  }

  const input: ExpiredRemovalInput = {
    ...parsed.data,
    bucketId: bucketId.data,
    occurredAt: parsed.data.occurredAt === undefined ? undefined : new Date(parsed.data.occurredAt),
    auth: authOf(actorId)
  }

  try {
    const operation = await service.removeExpiredBucket(input)
    respond(res, operation)
  } catch (error) {
    handleError(res, correlationId, error)
  }
}

const previewOpeningCountController = async (req: RequestExt, res: Response): Promise<void> => {
  const correlationId = correlationOf(req)
  const actorId = requireActor(res, correlationId)
  if (actorId === undefined) return

  try {
    const preview = previewOpeningCount(req.body as OpeningCountInput, {
      actorId,
      canManageStock: true,
      canApproveStockCount: false
    })
    res.status(HTTP_STATUS.OK).send(preview)
  } catch (error) {
    handleError(res, correlationId, error)
  }
}

const confirmOpeningCountController = async (req: RequestExt, res: Response, writer: OpeningCountWriter = openingCountWriter): Promise<void> => {
  const correlationId = correlationOf(req)
  const actorId = requireActor(res, correlationId)
  if (actorId === undefined || !isRecord(req.body)) {
    if (actorId !== undefined) invalidPayload(res, correlationId)
    return
  }

  try {
    const confirmation = await confirmOpeningCount(req.body as unknown as OpeningCountConfirmationInput, {
      actorId,
      canManageStock: true,
      canApproveStockCount: true
    }, writer)
    if (confirmation.evidence.status === STOCK_OPERATION_STATUSES.FAILED_RECOVERABLE) {
      sendErrorEnvelope(
        res,
        HTTP_STATUS.SERVICE_UNAVAILABLE,
        confirmation.evidence.errorCode ?? STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR,
        STOCK_ERROR_MESSAGES.STOCK_REPOSITORY_ERROR,
        correlationId
      )
      return
    }
    const status = confirmation.evidence.status === STOCK_OPERATION_STATUSES.IDEMPOTENT_RETRY
      ? HTTP_STATUS.OK
      : HTTP_STATUS.CREATED
    res.status(status).send(confirmation)
  } catch (error) {
    handleError(res, correlationId, error)
  }
}

export {
  getAvailability,
  getOverview,
  getProductDetail,
  updateMinimum,
  receivePurchase,
  returnSale,
  removeExpiredBucket,
  previewOpeningCountController as previewOpeningCount,
  confirmOpeningCountController as confirmOpeningCount
}
