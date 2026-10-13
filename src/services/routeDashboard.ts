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
const MAX_DASHBOARD_SNAPSHOTS = 1000
const MAX_DASHBOARD_CANDIDATES = 1000
const MAX_CONCURRENT_DASHBOARD_READS = 100
const MAX_DASHBOARD_ROUTE_STOPS = 50
const MAX_DASHBOARD_ROUTE_SALE_REFERENCES = 1000

interface ConcurrencyLimiter {
  run: <T>(task: () => Promise<T>) => Promise<T>
  activeCount: () => number
}

const createConcurrencyLimiter = (limit: number): ConcurrencyLimiter => {
  let active = 0
  const queue: Array<() => void> = []

  const drain = (): void => {
    while (active < limit && queue.length > 0) {
      active += 1
      queue.shift()?.()
    }
  }

  return {
    run: async <T>(task: () => Promise<T>): Promise<T> => await new Promise<T>((resolve, reject) => {
      queue.push(() => {
        void task().then(resolve, reject).finally(() => {
          active -= 1
          drain()
        })
      })
      drain()
    }),
    activeCount: () => active
  }
}

interface DashboardSnapshotRead {
  _id: unknown
  zoneSnapshot: { code: string }
  selectedSaleIds: string[]
  assignments?: RouteOperationalAssignment
  depot?: { name: string, latitude: number, longitude: number }
  stops: Array<{ clientId: string, saleIds: string[], sequence: number, latitude: number, longitude: number }>
  segments?: Array<{ fromStopSequence: number, toStopSequence: number, distanceMeters: number, durationSeconds: number }>
  metrics: { distanceMeters: number, durationSeconds: number, fuelLiters?: number, availability?: RouteDashboardCard['metricAvailability'] }
  warnings: string[]
  encodedPolyline?: string
  fuelAssumptions?: RouteDashboardCard['fuelAssumptions']
  scheduleAssumptions?: RouteDashboardCard['scheduleAssumptions']
  stopEstimates?: RouteDashboardCard['stopEstimates']
  saleReferences?: RouteDashboardCard['saleReferences']
}

interface DashboardProjectionRead {
  snapshotId: string
  status: RouteOperationalStatus
  assignments?: RouteOperationalAssignment
  stale?: boolean
  staleCauses?: RouteDashboardCard['staleCauses']
}

interface DashboardRequestContext {
  correlationId?: string
  actor?: string
  maxResults?: number
  truncated?: boolean
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

const routeCard = (snapshot: DashboardSnapshotRead, projection: DashboardProjectionRead | undefined, saleStatuses: string[]): RouteDashboardCard => {
  const card: RouteDashboardCard = {
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
    assignments: projection?.assignments ?? snapshot.assignments ?? {},
    warnings: [...snapshot.warnings],
    stale: projection?.stale === true
  }

  if (snapshot.depot !== undefined) card.depot = { ...snapshot.depot }
  if (snapshot.encodedPolyline !== undefined) card.encodedPolyline = snapshot.encodedPolyline
  if (snapshot.stops.length <= MAX_DASHBOARD_ROUTE_STOPS) card.stops = snapshot.stops.map((stop) => ({ ...stop, saleIds: [...stop.saleIds] }))
  if (snapshot.segments !== undefined) card.segments = snapshot.segments.slice(0, MAX_DASHBOARD_ROUTE_STOPS + 1).map((segment) => ({ ...segment }))
  if (snapshot.metrics.availability !== undefined) card.metricAvailability = snapshot.metrics.availability
  if (snapshot.fuelAssumptions !== undefined) card.fuelAssumptions = { ...snapshot.fuelAssumptions }
  if (snapshot.scheduleAssumptions !== undefined) card.scheduleAssumptions = { ...snapshot.scheduleAssumptions }
  if (snapshot.stopEstimates !== undefined) card.stopEstimates = snapshot.stopEstimates.slice(0, MAX_DASHBOARD_ROUTE_STOPS).map((estimate) => ({ ...estimate }))
  if (snapshot.saleReferences !== undefined) card.saleReferences = snapshot.saleReferences.slice(0, MAX_DASHBOARD_ROUTE_SALE_REFERENCES).map((reference) => ({ ...reference }))
  if (projection?.staleCauses !== undefined) card.staleCauses = [...projection.staleCauses]
  return card
}

const getDashboardRead = async (input: RouteDashboardQuery, context: DashboardRequestContext = {}): Promise<RouteDashboard> => {
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

    const candidateContext: DashboardRequestContext = { maxResults: MAX_DASHBOARD_CANDIDATES }
    const candidates = await getCandidates({ serviceDate: input.serviceDate, deliveryZoneId: String(zone._id) }, candidateContext)
    const snapshotRead = await RoutePlanModel.find({
      planningDate: { $gte: start, $lt: end },
      'zoneSnapshot.code': zone.code
    }).sort({ planningDate: 1, _id: 1 }).limit(MAX_DASHBOARD_SNAPSHOTS + 1).lean()
    const snapshotsTruncated = snapshotRead.length > MAX_DASHBOARD_SNAPSHOTS
    const snapshots = snapshotsTruncated ? snapshotRead.slice(0, MAX_DASHBOARD_SNAPSHOTS) : snapshotRead
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
    const oversizedRouteIds = new Set(snapshots.filter((snapshot) => snapshot.stops.length > MAX_DASHBOARD_ROUTE_STOPS || (snapshot.saleReferences?.length ?? 0) > MAX_DASHBOARD_ROUTE_SALE_REFERENCES).map((snapshot) => String(snapshot._id)))
    const totalDistanceMeters = routes.length === 0 ? null : routes.reduce((sum, route) => sum + route.metrics.distanceMeters, 0)
    const estimatedFuelLiters = routes.length === 0 || routes.some((route) => route.metrics.fuelLiters === null)
      ? null
      : routes.reduce((sum, route) => sum + (route.metrics.fuelLiters as number), 0)
    const warnings = [...new Set([
      ...routes.flatMap((route) => route.warnings),
      ...(routes.some((route) => route.stale) ? ['STALE_ROUTE_PLAN'] : []),
      ...(routes.some((route) => oversizedRouteIds.has(route.id)) ? ['DASHBOARD_ROUTE_DETAIL_LIMIT_REACHED'] : []),
      ...(snapshotsTruncated ? ['DASHBOARD_SNAPSHOT_LIMIT_REACHED'] : []),
      ...(candidateContext.truncated === true ? ['DASHBOARD_CANDIDATE_LIMIT_REACHED'] : []),
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

const dashboardReadLimiter = createConcurrencyLimiter(MAX_CONCURRENT_DASHBOARD_READS)

const getDashboard = async (input: RouteDashboardQuery, context: DashboardRequestContext = {}): Promise<RouteDashboard> => await dashboardReadLimiter.run(async () => await getDashboardRead(input, context))

export { MAX_CONCURRENT_DASHBOARD_READS, MAX_DASHBOARD_CANDIDATES, MAX_DASHBOARD_ROUTE_SALE_REFERENCES, MAX_DASHBOARD_ROUTE_STOPS, MAX_DASHBOARD_SNAPSHOTS, createConcurrencyLimiter, getDashboard }
