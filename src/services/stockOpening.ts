import { STOCK_RULES_VERSION } from '../config/stock'
import {
  INVENTORY_MOVEMENT_TYPES,
  STOCK_ERROR_CODES,
  STOCK_OPERATION_STATUSES,
  type OpeningCountConfirmationInput,
  type OpeningCountEvidence,
  type OpeningCountInput,
  type OpeningCountPlan,
  type OpeningCountPreview,
  type OpeningCountWriteContext,
  type OpeningCountWriter,
  type OpeningCountWriterResult,
  type StockAuthContext,
  type StockErrorCode
} from '../interfaces/stock.interface'
import {
  openingCountConfirmationInputSchema,
  openingCountInputSchema
} from '../schemas/stock.schema'

export class OpeningCountError extends Error {
  readonly code: StockErrorCode

  constructor (code: StockErrorCode, message: string) {
    super(message)
    this.name = 'OpeningCountError'
    this.code = code
  }
}

const forbidden = (): never => {
  throw new OpeningCountError(STOCK_ERROR_CODES.STOCK_FORBIDDEN, 'Caller lacks Stock opening-count capability')
}

const assertManageAuth = (auth: StockAuthContext): void => {
  if (typeof auth.actorId !== 'string' || !/^[a-fA-F0-9]{24}$/.test(auth.actorId) || !auth.canManageStock) forbidden()
}

const parseInput = (input: OpeningCountInput): OpeningCountInput => {
  const parsed = openingCountInputSchema.safeParse(input)
  if (!parsed.success) throw new OpeningCountError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Opening count input is invalid')
  return {
    operationId: parsed.data.operationId,
    rows: parsed.data.rows.map((row) => ({
      productId: row.productId.toLowerCase(),
      countedQuantity: row.countedQuantity,
      expiryDate: row.expiryDate ?? null
    }))
  }
}

const buildPlan = (input: OpeningCountInput): OpeningCountPlan => {
  const groups = input.rows.map((row) => ({
    productId: row.productId,
    expiryDate: row.expiryDate ?? null,
    countedQuantity: row.countedQuantity
  }))
  const keys = new Set<string>()
  for (const group of groups) {
    const key = `${group.productId}:${group.expiryDate ?? 'NONE'}`
    if (keys.has(key)) throw new OpeningCountError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, `Duplicate opening-count row ${key}`)
    keys.add(key)
  }
  groups.sort((left, right) => {
    const productComparison = left.productId.localeCompare(right.productId)
    if (productComparison !== 0) return productComparison
    return (left.expiryDate ?? '').localeCompare(right.expiryDate ?? '')
  })
  return {
    operationId: input.operationId,
    movementType: INVENTORY_MOVEMENT_TYPES.OPENING,
    groups,
    movementCount: groups.filter((group) => group.countedQuantity > 0).length,
    rulesVersion: STOCK_RULES_VERSION
  }
}

const pendingEvidence = (plan: OpeningCountPlan, actorId: string): OpeningCountEvidence => ({
  status: STOCK_OPERATION_STATUSES.PENDING,
  operationId: plan.operationId,
  actorId,
  rulesVersion: plan.rulesVersion,
  movementCount: plan.movementCount,
  businessDataMutated: false
})

export const previewOpeningCount = (input: OpeningCountInput, auth: StockAuthContext): OpeningCountPreview => {
  assertManageAuth(auth)
  const parsed = parseInput(input)
  const plan = buildPlan(parsed)
  return { plan, evidence: pendingEvidence(plan, auth.actorId) }
}

const confirmationPlan = (input: OpeningCountConfirmationInput, auth: StockAuthContext): { plan: OpeningCountPlan, context: OpeningCountWriteContext } => {
  assertManageAuth(auth)
  if (!auth.canApproveStockCount) forbidden()
  const parsed = openingCountConfirmationInputSchema.safeParse(input)
  if (!parsed.success) throw new OpeningCountError(STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE, 'Opening count approval metadata is invalid')
  // Assumption for the current deferred-permission slice: the authenticated actor must be the approval actor.
  const normalizedApprovedBy = parsed.data.approvedBy.toLowerCase()
  if (normalizedApprovedBy !== auth.actorId.toLowerCase()) forbidden()
  const normalized: OpeningCountInput = {
    operationId: parsed.data.operationId,
    rows: parsed.data.rows.map((row) => ({
      productId: row.productId.toLowerCase(),
      countedQuantity: row.countedQuantity,
      expiryDate: row.expiryDate ?? null
    }))
  }
  return {
    plan: buildPlan(normalized),
    context: { actorId: auth.actorId, approvedBy: normalizedApprovedBy, approvalId: parsed.data.approvalId }
  }
}

export const confirmOpeningCount = async (input: OpeningCountConfirmationInput, auth: StockAuthContext, writer: OpeningCountWriter): Promise<OpeningCountPreview> => {
  const { plan, context } = confirmationPlan(input, auth)
  let status: OpeningCountWriterResult['status'] = STOCK_OPERATION_STATUSES.FAILED_RECOVERABLE
  let movementCount = plan.movementCount
  try {
    const result = await writer(plan, context)
    status = result.status === STOCK_OPERATION_STATUSES.APPLIED ? STOCK_OPERATION_STATUSES.APPLIED : STOCK_OPERATION_STATUSES.FAILED_RECOVERABLE
    movementCount = result.movementCount
  } catch {
    status = STOCK_OPERATION_STATUSES.FAILED_RECOVERABLE
  }
  const evidence: OpeningCountEvidence = {
    status,
    operationId: plan.operationId,
    approvalId: context.approvalId,
    approvedBy: context.approvedBy,
    actorId: context.actorId,
    rulesVersion: plan.rulesVersion,
    movementCount,
    businessDataMutated: status === STOCK_OPERATION_STATUSES.APPLIED
  }
  return { plan, evidence }
}
