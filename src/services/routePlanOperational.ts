import { Types } from 'mongoose'
import RoutePlanOperationalModel from '../models/routePlanOperational'
import RoutePlanModel from '../models/routePlan'
import SaleModel from '../models/sale'
import { SALE_DELIVERY_STATUS } from '../interfaces/sale.interface'
import { type RouteOperationalAssignment, type RouteOperationalHistoryEntry, type RouteOperationalStatus, type RoutePlanOperational } from '../interfaces/routeOptimization.interface'
import { deriveRouteStatus } from './routeStateDerivation'

interface CreateOperationalInput {
  changedBy: string
  assignments?: RouteOperationalAssignment
}

interface RecomputeInput {
  changedBy: string
  expectedVersion?: number
}

interface AssignmentInput {
  version: number
  driverId: string
  vehicleId: string
  changedBy: string
}

type OperationalErrorCode = 'ROUTE_OPERATIONAL_NOT_FOUND' | 'ROUTE_OPERATIONAL_VERSION_CONFLICT' | 'ROUTE_OPERATIONAL_SALES_INVALID'

class OperationalProjectionError extends Error {
  readonly code: OperationalErrorCode
  readonly currentVersion?: number

  constructor (code: OperationalErrorCode, message: string, currentVersion?: number) {
    super(message)
    this.name = 'OperationalProjectionError'
    this.code = code
    this.currentVersion = currentVersion
  }
}

const selectedSaleState = async (snapshotId: string): Promise<{ saleIds: string[], status: RouteOperationalStatus, sourceDeliveryVersion: number }> => {
  const snapshot = await RoutePlanModel.findById(snapshotId).lean()
  if (snapshot === null) throw new OperationalProjectionError('ROUTE_OPERATIONAL_NOT_FOUND', 'Route plan snapshot was not found')
  const saleIds = snapshot.selectedSaleIds.map(String)
  if (saleIds.length === 0) throw new OperationalProjectionError('ROUTE_OPERATIONAL_SALES_INVALID', 'Route plan has no selected sales')
  const objectIds = saleIds.filter((saleId) => Types.ObjectId.isValid(saleId)).map((saleId) => new Types.ObjectId(saleId))
  const sales = objectIds.length === 0 ? [] : await SaleModel.find({ _id: { $in: objectIds } }, { _id: 1, delivery: 1, updatedAt: 1 }).lean()
  const deliveryById = new Map(sales.map((sale) => [String(sale._id), sale]))
  if (saleIds.some((saleId) => deliveryById.get(saleId) === undefined)) throw new OperationalProjectionError('ROUTE_OPERATIONAL_SALES_INVALID', 'Route plan references an unavailable sale')
  const deliveries = saleIds.map((saleId) => deliveryById.get(saleId)?.delivery?.status ?? SALE_DELIVERY_STATUS.PENDING)
  const sourceDeliveryVersion = sales.reduce((latest, sale) => {
    const updatedAtValue = (sale as unknown as { updatedAt?: Date }).updatedAt
    const updatedAt = updatedAtValue instanceof Date ? updatedAtValue.getTime() : 0
    return Math.max(latest, updatedAt)
  }, 0)
  return { saleIds, status: deriveRouteStatus(deliveries), sourceDeliveryVersion }
}

const historyEntry = (status: RouteOperationalStatus, assignments: RouteOperationalAssignment, changedBy: string, version: number): RouteOperationalHistoryEntry => ({
  status,
  ...(assignments.driverId === undefined ? {} : { driverId: assignments.driverId }),
  ...(assignments.vehicleId === undefined ? {} : { vehicleId: assignments.vehicleId }),
  changedBy,
  changedAt: new Date(),
  version
})

const createProjection = async (snapshotId: string, input: CreateOperationalInput): Promise<RoutePlanOperational> => {
  const current = await RoutePlanOperationalModel.findOne({ snapshotId }).lean()
  if (current !== null) return current
  const state = await selectedSaleState(snapshotId)
  const snapshot = await RoutePlanModel.findById(snapshotId).lean()
  const assignments = input.assignments ?? snapshot?.assignments ?? {}
  const projection = await RoutePlanOperationalModel.create({
    snapshotId,
    status: state.status,
    sourceDeliveryVersion: state.sourceDeliveryVersion,
    assignments,
    history: [historyEntry(state.status, assignments, input.changedBy, 1)],
    version: 1,
    updatedBy: input.changedBy
  })
  return projection.toObject() as unknown as RoutePlanOperational
}

const recomputeState = async (snapshotId: string, input: RecomputeInput): Promise<RoutePlanOperational> => {
  const state = await selectedSaleState(snapshotId)
  const current = await RoutePlanOperationalModel.findOne({ snapshotId }).lean()
  if (current === null) return await createProjection(snapshotId, { changedBy: input.changedBy })
  if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
    throw new OperationalProjectionError('ROUTE_OPERATIONAL_VERSION_CONFLICT', `Route operation is stale; refresh version ${current.version} before retrying`, current.version)
  }
  if (current.status === state.status && current.sourceDeliveryVersion === state.sourceDeliveryVersion) return current as unknown as RoutePlanOperational
  const nextVersion = current.version + 1
  const updated = await RoutePlanOperationalModel.findOneAndUpdate(
    { snapshotId, version: current.version },
    { $set: { status: state.status, sourceDeliveryVersion: state.sourceDeliveryVersion, updatedBy: input.changedBy }, $inc: { version: 1 }, $push: { history: historyEntry(state.status, current.assignments, input.changedBy, nextVersion) } },
    { new: true }
  ).lean()
  if (updated === null) throw new OperationalProjectionError('ROUTE_OPERATIONAL_VERSION_CONFLICT', 'Route operation changed concurrently; refresh and retry')
  return updated as unknown as RoutePlanOperational
}

const assign = async (snapshotId: string, input: AssignmentInput): Promise<RoutePlanOperational> => {
  const state = await selectedSaleState(snapshotId)
  const current = await RoutePlanOperationalModel.findOne({ snapshotId, version: input.version }).lean()
  if (current === null) {
    const latest = await RoutePlanOperationalModel.findOne({ snapshotId }).lean()
    if (latest === null) throw new OperationalProjectionError('ROUTE_OPERATIONAL_NOT_FOUND', 'Operational route projection was not found')
    throw new OperationalProjectionError('ROUTE_OPERATIONAL_VERSION_CONFLICT', `Route operation is stale; refresh version ${latest.version} before retrying`, latest.version)
  }
  const assignments = { driverId: input.driverId, vehicleId: input.vehicleId }
  const nextVersion = input.version + 1
  const updated = await RoutePlanOperationalModel.findOneAndUpdate(
    { snapshotId, version: input.version },
    { $set: { status: state.status, sourceDeliveryVersion: state.sourceDeliveryVersion, assignments, updatedBy: input.changedBy }, $inc: { version: 1 }, $push: { history: historyEntry(state.status, assignments, input.changedBy, nextVersion) } },
    { new: true }
  ).lean()
  if (updated === null) throw new OperationalProjectionError('ROUTE_OPERATIONAL_VERSION_CONFLICT', 'Route operation changed concurrently; refresh and retry')
  return updated as unknown as RoutePlanOperational
}

const recomputeForSale = async (saleId: string, changedBy: string): Promise<void> => {
  const snapshots = await RoutePlanModel.find({ selectedSaleIds: saleId }, { _id: 1 }).lean()
  for (const snapshot of snapshots) {
    const projection = await RoutePlanOperationalModel.findOne({ snapshotId: String(snapshot._id) }).lean()
    if (projection !== null) await recomputeState(String(snapshot._id), { changedBy })
  }
}

export { assign, createProjection, recomputeForSale, recomputeState, OperationalProjectionError }
export type { AssignmentInput, CreateOperationalInput, RecomputeInput }
