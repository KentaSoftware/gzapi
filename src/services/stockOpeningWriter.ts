import { createHash } from 'node:crypto'

import { STOCK_RULES_VERSION } from '../config/stock'
import {
  BASELINE_STATUS,
  EXPIRY_TRACKING,
  INVENTORY_MOVEMENT_TYPES,
  STOCK_ERROR_CODES,
  STOCK_OPERATION_STATUSES,
  type OpeningCountBucketReconciliation,
  type OpeningCountOperation,
  type OpeningCountPlan,
  type OpeningCountPlanGroup,
  type OpeningCountWriteContext,
  type OpeningCountWriter,
  type StockMovementRecord,
  type StockOpeningRepository
} from '../interfaces/stock.interface'
import { StockServiceError } from './stock'
import { createMongooseStockOpeningRepository } from './stockMongoRepository'

const OPENING_SOURCE = {
  TYPE: 'OPENING_COUNT',
  EVENT: 'OPENING_COUNT_CONFIRMED'
} as const

const OBJECT_ID_PATTERN = /^[a-fA-F0-9]{24}$/
const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

interface OpeningProductState {
  productId: string
  expiryTracking: OpeningProductTracking
  groups: OpeningCountPlanGroup[]
  buckets: StockBucketState[]
}

interface StockBucketState {
  bucketId: string
  expiryDate: string
  receivedQuantity: number
  availableQuantity: number
  committedQuantity: number
}

const OPENING_PRODUCT_TRACKING = {
  TRACKED: EXPIRY_TRACKING.TRACKED,
  NOT_TRACKED: EXPIRY_TRACKING.NOT_TRACKED
} as const

type OpeningProductTracking = (typeof OPENING_PRODUCT_TRACKING)[keyof typeof OPENING_PRODUCT_TRACKING]

const openingError = (code: (typeof STOCK_ERROR_CODES)[keyof typeof STOCK_ERROR_CODES], message: string): StockServiceError =>
  new StockServiceError(code, message)

const isCivilDate = (value: string): boolean => {
  if (!CIVIL_DATE_PATTERN.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

const planFingerprint = (plan: OpeningCountPlan): string => createHash('sha256')
  .update(JSON.stringify({
    operationId: plan.operationId,
    movementType: plan.movementType,
    groups: plan.groups,
    movementCount: plan.movementCount,
    rulesVersion: plan.rulesVersion
  }), 'utf8')
  .digest('hex')

const idempotencyKey = (operationId: string, group: OpeningCountPlanGroup): string => createHash('sha256')
  .update(`stock-opening-count:v1:${operationId}:${group.productId}:${group.expiryDate ?? 'NONE'}`, 'utf8')
  .digest('hex')

const sameMovementSemantics = (left: StockMovementRecord, right: StockMovementRecord): boolean =>
  left.productId === right.productId &&
  left.expiryBucketId === right.expiryBucketId &&
  left.type === right.type &&
  left.quantity === right.quantity &&
  left.sourceType === right.sourceType &&
  left.sourceId === right.sourceId &&
  left.sourceEvent === right.sourceEvent &&
  left.operationId === right.operationId &&
  left.idempotencyKey === right.idempotencyKey &&
  left.rulesVersion === right.rulesVersion &&
  left.createdBy === right.createdBy

const validatePlan = (plan: OpeningCountPlan, context: OpeningCountWriteContext): void => {
  if (!OBJECT_ID_PATTERN.test(context.actorId) || context.actorId !== context.approvedBy) {
    throw openingError(STOCK_ERROR_CODES.STOCK_FORBIDDEN, 'Authenticated actor must be the approval actor')
  }
  if (plan.movementType !== INVENTORY_MOVEMENT_TYPES.OPENING || plan.rulesVersion !== STOCK_RULES_VERSION) {
    throw openingError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Opening count plan version or type is invalid')
  }
  if (typeof plan.operationId !== 'string' || plan.operationId.trim() === '' || plan.groups.length === 0) {
    throw openingError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Opening count plan is incomplete')
  }
  const keys = new Set<string>()
  let movementCount = 0
  for (const group of plan.groups) {
    if (!OBJECT_ID_PATTERN.test(group.productId) || !Number.isSafeInteger(group.countedQuantity) || group.countedQuantity < 0) {
      throw openingError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Opening count row is invalid')
    }
    if (group.expiryDate !== null && !isCivilDate(group.expiryDate)) {
      throw openingError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Opening count expiry date is invalid')
    }
    const key = `${group.productId}:${group.expiryDate ?? 'NONE'}`
    if (keys.has(key)) throw openingError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Duplicate opening-count row ${key}`)
    keys.add(key)
    if (group.countedQuantity > 0) movementCount += 1
  }
  if (movementCount !== plan.movementCount) throw openingError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Opening count movement count is invalid')
}

const operationMatches = (operation: OpeningCountOperation, plan: OpeningCountPlan, context: OpeningCountWriteContext): boolean =>
  operation.actorId === context.actorId &&
  operation.approvedBy === context.approvedBy &&
  operation.approvalId === context.approvalId &&
  operation.planFingerprint === planFingerprint(plan) &&
  operation.rulesVersion === plan.rulesVersion &&
  operation.status === STOCK_OPERATION_STATUSES.APPLIED

const createMovement = (plan: OpeningCountPlan, group: OpeningCountPlanGroup, context: OpeningCountWriteContext, bucketId: string | undefined, occurredAt: Date): StockMovementRecord => ({
  productId: group.productId,
  ...(bucketId === undefined ? {} : { expiryBucketId: bucketId }),
  type: INVENTORY_MOVEMENT_TYPES.OPENING,
  quantity: group.countedQuantity,
  occurredAt: new Date(occurredAt.getTime()),
  sourceType: OPENING_SOURCE.TYPE,
  sourceId: plan.operationId,
  sourceEvent: OPENING_SOURCE.EVENT,
  operationId: plan.operationId,
  idempotencyKey: idempotencyKey(plan.operationId, group),
  rulesVersion: plan.rulesVersion,
  createdBy: context.actorId,
  createdAt: new Date(occurredAt.getTime()),
  updatedAt: new Date(occurredAt.getTime())
})

const validateProducts = async (repository: StockOpeningRepository, plan: OpeningCountPlan, session: { transactionId: string }): Promise<OpeningProductState[]> => {
  const grouped = new Map<string, OpeningCountPlanGroup[]>()
  for (const group of plan.groups) grouped.set(group.productId, [...(grouped.get(group.productId) ?? []), group])
  const states: OpeningProductState[] = []

  for (const [productId, groups] of grouped.entries()) {
    const product = await repository.getProduct(productId, session)
    if (product === undefined) throw openingError(STOCK_ERROR_CODES.STOCK_PRODUCT_NOT_FOUND, `Product ${productId} was not found`)
    if (product.baselineStatus === BASELINE_STATUS.RECONCILED) {
      throw openingError(STOCK_ERROR_CODES.STOCK_BASELINE_ALREADY_RECONCILED, `Product ${productId} baseline is already reconciled`)
    }
    if (product.baselineStatus !== BASELINE_STATUS.UNVERIFIED) {
      throw openingError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Product ${productId} baseline status is invalid`)
    }
    if (product.expiryTracking === EXPIRY_TRACKING.UNKNOWN) {
      throw openingError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Expiry tracking is unknown for ${productId}`)
    }
    const buckets = await repository.getBuckets(productId, session)
    if (buckets.some((bucket) => bucket.committedQuantity > 0)) {
      throw openingError(STOCK_ERROR_CODES.STOCK_BUCKET_HAS_COMMITMENTS, `Product ${productId} has committed expiry buckets`)
    }
    if (product.expiryTracking === EXPIRY_TRACKING.TRACKED && groups.some((group) => group.expiryDate === null)) {
      throw openingError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Expiry date is required for ${productId}`)
    }
    if (product.expiryTracking === EXPIRY_TRACKING.NOT_TRACKED && groups.some((group) => group.expiryDate !== null)) {
      throw openingError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Expiry date is not valid for ${productId}`)
    }
    states.push({
      productId,
      expiryTracking: product.expiryTracking,
      groups,
      buckets: buckets.map((bucket) => ({
        bucketId: bucket.bucketId,
        expiryDate: bucket.expiryDate,
        receivedQuantity: bucket.receivedQuantity,
        availableQuantity: bucket.availableQuantity,
        committedQuantity: bucket.committedQuantity
      }))
    })
  }
  return states
}

const openingBuckets = (state: OpeningProductState): OpeningCountBucketReconciliation[] => state.groups.map((group) => ({
  expiryDate: group.expiryDate as string,
  receivedQuantity: group.countedQuantity,
  availableQuantity: group.countedQuantity
}))

export const createOpeningCountWriter = (repository: StockOpeningRepository = createMongooseStockOpeningRepository()): OpeningCountWriter => async (plan, context) => {
  validatePlan(plan, context)
  return await repository.withTransaction(async (transaction) => {
    const session = transaction.session
    const existingOperation = await transaction.getOpeningOperation(plan.operationId, session)
    if (existingOperation !== undefined) {
      if (!operationMatches(existingOperation, plan, context)) {
        throw openingError(STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT, `Opening operation ${plan.operationId} conflicts with existing evidence`)
      }
      return { status: STOCK_OPERATION_STATUSES.IDEMPOTENT_RETRY, movementCount: existingOperation.movementCount }
    }

    const states = await validateProducts(transaction, plan, session)
    const now = new Date()
    const movements: StockMovementRecord[] = []
    for (const state of states) {
      for (const group of state.groups) {
        if (group.countedQuantity === 0) continue
        const bucket = state.buckets.find((candidate) => candidate.expiryDate === group.expiryDate)
        const movement = createMovement(plan, group, context, bucket?.bucketId, now)
        const existingMovement = await transaction.findMovementByIdempotencyKey(movement.idempotencyKey, session)
        if (existingMovement !== undefined && !sameMovementSemantics(existingMovement, movement)) {
          throw openingError(STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT, `Opening movement ${movement.idempotencyKey} conflicts with existing evidence`)
        }
        if (existingMovement === undefined) movements.push(movement)
      }
    }

    const operation: OpeningCountOperation = {
      operationId: plan.operationId,
      actorId: context.actorId,
      approvedBy: context.approvedBy,
      approvalId: context.approvalId,
      planFingerprint: planFingerprint(plan),
      rulesVersion: plan.rulesVersion,
      status: STOCK_OPERATION_STATUSES.APPLIED,
      movementCount: plan.movementCount,
      createdAt: now,
      updatedAt: now
    }
    await transaction.insertOpeningOperation(operation, session)
    for (const movement of movements) await transaction.insertMovement(movement, session)
    for (const state of states) {
      if (state.expiryTracking === EXPIRY_TRACKING.TRACKED) {
        await transaction.reconcileOpeningBuckets(state.productId, openingBuckets(state), session)
      } else {
        await transaction.clearOpeningBuckets(state.productId, session)
      }
      const physicalQuantity = state.groups.reduce((total, group) => total + group.countedQuantity, 0)
      await transaction.reconcileOpeningProduct(state.productId, physicalQuantity, context.actorId, now, session)
    }
    return { status: STOCK_OPERATION_STATUSES.APPLIED, movementCount: plan.movementCount }
  })
}
