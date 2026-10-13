import { fromZonedTime } from 'date-fns-tz'
import { Types } from 'mongoose'
import {
  ROUTE_OPERATIONAL_STATUS,
  type CandidateResult,
  type RouteDashboard,
  type RouteDashboardCard,
  type RouteDashboardQuery,
  type RouteOperationalAssignment,
  type RouteOperationalStatus
} from '../interfaces/routeOptimization.interface'
import DeliveryZoneModel from '../models/deliveryZone'
import RoutePlanModel from '../models/routePlan'
import RoutePlanOperationalModel from '../models/routePlanOperational'
import SaleModel from '../models/sale'
import { getCandidates } from './routePlan'

const SERVICE_TIME_ZONE = 'America/Argentina/Buenos_Aires'

interface DashboardSnapshotRead {
  _id: unknown
  zoneSnapshot: { code: string }
  selectedSaleIds: string[]
  stops: unknown[]
  metrics: { distanceMeters: number, durationSeconds: number, fuelLiters?: number }
  warnings: string[]
}

interface DashboardProjectionRead {
  snapshotId: string
  status: RouteOperationalStatus
  assignments?: RouteOperationalAssignment
  stale?: boolean
}

interface DashboardRequestContext {
  correlationId?: string
  actor?: string
}

const logDashboardEvent = (event: string, context: DashboardRequestContext, startedAt: number, outcome: string, routeSnapshotId?: string): void => {
  console.log(JSON.stringify({
    event,
    operation: 'dashboard.read',
    outcome,
    correlationId: context.correlationId,
    latencyMs: Date.now() - startedAt,
    actor: context.actor,
    routeSnapshotId
  }))
}

const serviceDateRange = (serviceDate: string): { start: Date, end: Date } => {
  const [year, month, day] = serviceDate.split('-').map(Number)
  const nextCivilDate = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)
  return {
    start: fromZonedTime(`${serviceDate}T00:00:00`, SERVICE_TIME_ZONE),
    end: fromZonedTime(`${nextCivilDate}T00:00:00`, SERVICE_TIME_ZONE)
  }
}

const deriveStatus = (statuses: string[]): RouteOperationalStatus => {
  if (statuses.length > 0 && statuses.every((status) => status === 'DELIVERED')) return ROUTE_OPERATIONAL_STATUS.COMPLETED
  if (statuses.some((status) => status === 'DELIVERED')) return ROUTE_OPERATIONAL_STATUS.IN_PROGRESS
  return ROUTE_OPERATIONAL_STATUS.PENDING
}

const routeCard = (snapshot: DashboardSnapshotRead, projection: DashboardProjectionRead | undefined, saleStatuses: string[]): RouteDashboardCard => ({
  id: String(snapshot._id),
  status: projection?.status ?? deriveStatus(saleStatuses),
  zoneCode: snapshot.zoneSnapshot.code,
  selectedSaleIds: [...snapshot.selectedSaleIds],
  clientCount: snapshot.stops.length,
  metrics: {
    distanceMeters: snapshot.metrics.distanceMeters,
    durationSeconds: snapshot.metrics.durationSeconds,
    fuelLiters: typeof snapshot.metrics.fuelLiters === 'number' ? snapshot.metrics.fuelLiters : null
  },
  assignments: projection?.assignments ?? {},
  warnings: [...snapshot.warnings],
  stale: projection?.stale === true
})

const getDashboard = async (input: RouteDashboardQuery, context: DashboardRequestContext = {}): Promise<RouteDashboard> => {
  const startedAt = Date.now()
  try {
    const { start, end } = serviceDateRange(input.serviceDate)
    const zone = await DeliveryZoneModel.findOne({ code: input.zoneCode, active: true }).lean()
    const emptyCandidates: CandidateResult = { eligible: [], blocked: [], ruleVersion: 'candidate-eligibility-v1' }
    if (zone === null) {
      const result = {
        filters: input,
        kpis: { activeRoutes: 0, pendingOrders: 0, totalDistanceMeters: null, estimatedFuelLiters: null },
        routes: [],
        candidates: emptyCandidates,
        warnings: ['DELIVERY_ZONE_NOT_FOUND']
      }
      logDashboardEvent('route_dashboard_read', context, startedAt, 'ROUTE_ZONE_NOT_FOUND')
      return result
    }

    const candidates = await getCandidates({ serviceDate: input.serviceDate, deliveryZoneId: String(zone._id) })
    const snapshots = await RoutePlanModel.find({
      planningDate: { $gte: start, $lt: end },
      'zoneSnapshot.code': zone.code
    }).sort({ planningDate: 1, _id: 1 }).lean()
    const snapshotIds = snapshots.map((snapshot) => String(snapshot._id))
    const projections = snapshotIds.length === 0
      ? []
      : await RoutePlanOperationalModel.find({ snapshotId: { $in: snapshotIds } }).lean()
    const projectionBySnapshotId = new Map(projections.map((projection) => [projection.snapshotId, projection]))
    const saleIds = [...new Set(snapshots.flatMap((snapshot) => snapshot.selectedSaleIds))]
    const validSaleIds = saleIds.filter((id) => Types.ObjectId.isValid(id))
    const sales = validSaleIds.length === 0 ? [] : await SaleModel.find({ _id: { $in: validSaleIds.map((id) => new Types.ObjectId(id)) } }, { _id: 1, 'delivery.status': 1 }).lean()
    const statusBySaleId = new Map(sales.map((sale) => [String(sale._id), sale.delivery?.status ?? 'PENDING']))
    const allRoutes = snapshots.map((snapshot) => routeCard(snapshot, projectionBySnapshotId.get(String(snapshot._id)), snapshot.selectedSaleIds.map((saleId) => statusBySaleId.get(saleId) ?? 'PENDING')))
    const routes = input.status === undefined ? allRoutes : allRoutes.filter((route) => route.status === input.status)
    const totalDistanceMeters = routes.length === 0 ? null : routes.reduce((sum, route) => sum + route.metrics.distanceMeters, 0)
    const estimatedFuelLiters = routes.length === 0 || routes.some((route) => route.metrics.fuelLiters === null)
      ? null
      : routes.reduce((sum, route) => sum + (route.metrics.fuelLiters as number), 0)
    const warnings = [...new Set([
      ...routes.flatMap((route) => route.warnings),
      ...(routes.some((route) => route.stale) ? ['STALE_ROUTE_PLAN'] : []),
      ...(routes.length === 0 && candidates.eligible.length === 0 && candidates.blocked.length === 0 ? ['NO_DASHBOARD_DATA'] : [])
    ])]

    const result = {
      filters: input,
      kpis: {
        activeRoutes: routes.length,
        pendingOrders: candidates.eligible.length,
        totalDistanceMeters,
        estimatedFuelLiters
      },
      routes,
      candidates,
      warnings
    }
    logDashboardEvent('route_dashboard_read', context, startedAt, 'SUCCESS', routes[0]?.id)
    return result
  } catch (error) {
    logDashboardEvent('route_dashboard_read', context, startedAt, 'INTERNAL_ERROR')
    throw error
  }
}

export { getDashboard }
