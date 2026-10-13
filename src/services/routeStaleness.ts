import {
  ROUTE_SNAPSHOT_STALENESS_CAUSE,
  type RoutePlan,
  type RouteSnapshotSaleRef,
  type RouteSnapshotStaleness,
  type RouteSnapshotStalenessCause,
  type RouteSnapshotSaleReference
} from '../interfaces/routeOptimization.interface'
import type { SaleDeliveryStatus } from '../interfaces/sale.interface'

interface CurrentSaleDelivery {
  status?: SaleDeliveryStatus | string
}

interface SaleReadModel {
  saleId?: string
  _id?: string | { toString: () => string }
  updatedAt?: Date | number | string
  estado?: string
  delivery?: CurrentSaleDelivery
}

interface Stringifiable {
  toString: () => string
}

const CANCELLED_STATUSES = {
  CANCELLED: 'CANCELLED',
  CANCELED: 'CANCELED'
} as const

function saleIdentity (sale: SaleReadModel): string | null {
  if (typeof sale.saleId === 'string') return sale.saleId
  if (typeof sale._id === 'string') return sale._id
  if (sale._id != null) return sale._id.toString()
  return null
}

function normalizeVersion (updatedAt: SaleReadModel['updatedAt']): number | null {
  if (updatedAt == null) return null
  const timestamp = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime()
  return Number.isFinite(timestamp) ? timestamp : null
}

function normalizeStatus (sale: SaleReadModel): SaleDeliveryStatus | null {
  const status = sale.delivery?.status
  return status === 'PENDING' || status === 'DELIVERED' ? status : null
}

function isCancelled (sale: SaleReadModel): boolean {
  const status = sale.delivery?.status?.toUpperCase()
  const saleStatus = sale.estado?.toUpperCase()
  return status === CANCELLED_STATUSES.CANCELLED ||
    status === CANCELLED_STATUSES.CANCELED ||
    saleStatus === CANCELLED_STATUSES.CANCELLED ||
    saleStatus === CANCELLED_STATUSES.CANCELED
}

function snapshotId (snapshot: RoutePlan): string {
  if (typeof snapshot._id === 'string') return snapshot._id
  if (isStringifiable(snapshot._id)) return snapshot._id.toString()
  return ''
}

function isStringifiable (value: unknown): value is Stringifiable {
  return typeof value === 'object' && value != null && 'toString' in value && typeof value.toString === 'function'
}

function addCause (causes: RouteSnapshotStalenessCause[], cause: RouteSnapshotStalenessCause): void {
  if (!causes.includes(cause)) causes.push(cause)
}

export function detectStaleness (snapshot: RoutePlan, currentSales: SaleReadModel[]): RouteSnapshotStaleness {
  const salesById = new Map<string, SaleReadModel>()
  for (const sale of currentSales) {
    const id = saleIdentity(sale)
    if (id != null) salesById.set(id, sale)
  }

  const saleRefs: RouteSnapshotSaleRef[] = (snapshot.saleReferences ?? []).map((reference: RouteSnapshotSaleReference) => {
    const currentSale = salesById.get(reference.saleId)
    const currentVersion = normalizeVersion(currentSale?.updatedAt)
    const currentStatus = currentSale == null ? null : normalizeStatus(currentSale)
    return { saleId: reference.saleId, versionAtSave: reference.versionAtSave, currentVersion, currentStatus }
  })
  const causes: RouteSnapshotStalenessCause[] = []

  for (const [index, reference] of (snapshot.saleReferences ?? []).entries()) {
    const currentSale = salesById.get(reference.saleId)
    if (currentSale == null || isCancelled(currentSale)) {
      addCause(causes, ROUTE_SNAPSHOT_STALENESS_CAUSE.CANCELLED)
      continue
    }
    const currentRef = saleRefs[index]
    if (currentRef.currentVersion !== reference.versionAtSave || currentRef.currentStatus !== reference.statusAtSave) {
      addCause(causes, ROUTE_SNAPSHOT_STALENESS_CAUSE.MODIFIED)
    }
  }

  return {
    snapshotId: snapshotId(snapshot),
    stale: causes.length > 0,
    causes,
    saleRefs,
    detectedAt: new Date()
  }
}
