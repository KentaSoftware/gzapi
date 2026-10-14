import { fromZonedTime } from 'date-fns-tz'
import { Types } from 'mongoose'
import {
  ROUTE_OPERATIONAL_STATUS,
  ROUTE_MAP_LOCATION_STATUS,
  type BlockedCandidateEntry,
  type CandidateEntry,
  type CandidateResult,
  type RouteDashboard,
  type RouteDashboardCard,
  type RouteDashboardQuery,
  type RouteDashboardScopedQuery,
  type RouteMapLocation,
  type RouteOperationalAssignment,
  type RouteOperationalStatus
} from '../interfaces/routeOptimization.interface'
import DeliveryZoneModel from '../models/deliveryZone'
import RoutePlanModel from '../models/routePlan'
import RoutePlanOperationalModel from '../models/routePlanOperational'
import SaleModel from '../models/sale'
import ClientModel from '../models/client'
import { getCandidates, getGlobalCandidates } from './routePlan'

const SERVICE_TIME_ZONE = 'America/Argentina/Buenos_Aires'
const MAX_DASHBOARD_SNAPSHOTS = 1000
const MAX_DASHBOARD_CANDIDATES = 1000
const MAX_DASHBOARD_MAP_LOCATIONS = 1000
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

const distanceThroughStop = (snapshot: DashboardSnapshotRead, sequence: number): number | undefined => {
  if (sequence < 1 || snapshot.segments === undefined) return undefined

  const segmentByDestination = new Map(snapshot.segments.map((segment) => [segment.toStopSequence, segment]))
  let cumulativeDistance = 0
  for (let stopSequence = 1; stopSequence <= sequence; stopSequence += 1) {
    const segment = segmentByDestination.get(stopSequence)
    if (segment?.fromStopSequence !== stopSequence - 1 || !Number.isFinite(segment.distanceMeters) || segment.distanceMeters < 0) return undefined
    cumulativeDistance += segment.distanceMeters
  }
  return cumulativeDistance
}

const enrichCandidatesWithRouteDistances = (candidates: CandidateResult, snapshots: DashboardSnapshotRead[]): CandidateResult => {
  const distanceByClientId = new Map<string, number>()
  for (const snapshot of snapshots) {
    for (const stop of snapshot.stops) {
      const distance = distanceThroughStop(snapshot, stop.sequence)
      if (distance !== undefined && !distanceByClientId.has(stop.clientId)) distanceByClientId.set(stop.clientId, distance)
    }
  }

  const withDistance = <T extends CandidateEntry>(candidate: T): T => {
    const distance = candidate.clientId === undefined ? undefined : distanceByClientId.get(candidate.clientId)
    return distance === undefined ? candidate : { ...candidate, distanceMeters: distance }
  }

  return {
    ...candidates,
    eligible: candidates.eligible.map(withDistance),
    blocked: candidates.blocked.map((candidate: BlockedCandidateEntry) => withDistance(candidate))
  }
}

const getMapLocations = async (zoneId: unknown, serviceDate: string, candidates: CandidateResult): Promise<RouteMapLocation[]> => {
  const { start, end } = serviceDateRange(serviceDate)
  const clients = await ClientModel.find({ isActive: true, deliveryZoneId: zoneId }).lean()
  const sales = await SaleModel.find(
    { 'delivery.status': 'PENDING', 'delivery.serviceDate': { $gte: start, $lt: end } },
    { _id: 1, idCliente: 1 }
  ).lean()
  const pendingClientIds = new Set(sales.map((sale) => sale.idCliente === undefined ? undefined : String(sale.idCliente)).filter((id): id is string => id !== undefined))
  const eligibleClientIds = new Set(candidates.eligible.map((candidate) => candidate.clientId).filter((id): id is string => id !== undefined))
  const blockedClientIds = new Set(candidates.blocked.map((candidate) => candidate.clientId).filter((id): id is string => id !== undefined))

  return clients
    .filter((client) => Number.isFinite(client.lat) && Number.isFinite(client.lng))
    .map((client): RouteMapLocation => {
      const clientId = String(client._id)
      const status = eligibleClientIds.has(clientId) || (pendingClientIds.has(clientId) && !blockedClientIds.has(clientId))
        ? ROUTE_MAP_LOCATION_STATUS.ORDER
        : blockedClientIds.has(clientId) ? ROUTE_MAP_LOCATION_STATUS.EXCLUDED : ROUTE_MAP_LOCATION_STATUS.NO_ORDER
      return {
        clientId,
        displayName: client.nombreCompleto,
        ...(client.address === undefined || client.address.trim() === '' ? {} : { addressSummary: client.address }),
        latitude: client.lat as number,
        longitude: client.lng as number,
        status
      }
    })
}

interface GlobalMapLocationsRead {
  locations: RouteMapLocation[]
  truncated: boolean
}

const getGlobalMapLocations = async (candidates: CandidateResult): Promise<GlobalMapLocationsRead> => {
  const clientsRead = await ClientModel.find({ isActive: true }).sort({ _id: 1 }).limit(MAX_DASHBOARD_MAP_LOCATIONS + 1).lean()
  const truncated = clientsRead.length > MAX_DASHBOARD_MAP_LOCATIONS
  const clients = truncated ? clientsRead.slice(0, MAX_DASHBOARD_MAP_LOCATIONS) : clientsRead
  const sales = await SaleModel.find({ 'delivery.status': 'PENDING' }, { _id: 1, idCliente: 1 }).sort({ _id: 1 }).limit(MAX_DASHBOARD_CANDIDATES).lean()
  const pendingClientIds = new Set(sales.map((sale) => sale.idCliente === undefined ? undefined : String(sale.idCliente)).filter((id): id is string => id !== undefined))
  const eligibleClientIds = new Set(candidates.eligible.map((candidate) => candidate.clientId).filter((id): id is string => id !== undefined))
  const blockedClientIds = new Set(candidates.blocked.map((candidate) => candidate.clientId).filter((id): id is string => id !== undefined))

  const locations = clients
    .filter((client) => Number.isFinite(client.lat) && Number.isFinite(client.lng))
    .map((client): RouteMapLocation => {
      const clientId = String(client._id)
      const status = eligibleClientIds.has(clientId) || (pendingClientIds.has(clientId) && !blockedClientIds.has(clientId))
        ? ROUTE_MAP_LOCATION_STATUS.ORDER
        : blockedClientIds.has(clientId)
          ? ROUTE_MAP_LOCATION_STATUS.EXCLUDED
          : ROUTE_MAP_LOCATION_STATUS.NO_ORDER
      return {
        clientId,
        displayName: client.nombreCompleto,
        ...(client.address === undefined || client.address.trim() === '' ? {} : { addressSummary: client.address }),
        latitude: client.lat as number,
        longitude: client.lng as number,
        status
      }
    })

  return { locations, truncated }
}

const isScopedDashboardQuery = (input: RouteDashboardQuery): input is RouteDashboardScopedQuery =>
  'serviceDate' in input && 'zoneCode' in input && input.serviceDate !== undefined && input.zoneCode !== undefined

const getDashboardRead = async (input: RouteDashboardQuery, context: DashboardRequestContext = {}): Promise<RouteDashboard> => {
  const startedAt = Date.now()
  try {
    const emptyCandidates: CandidateResult = { eligible: [], blocked: [], ruleVersion: 'candidate-eligibility-v1' }
    const candidateContext: DashboardRequestContext = { maxResults: MAX_DASHBOARD_CANDIDATES }
    let candidates: CandidateResult
    let mapLocations: RouteMapLocation[]
    let mapLocationsTruncated = false
    let snapshotRead: DashboardSnapshotRead[]
    let zoneNotFound = false

    if (isScopedDashboardQuery(input)) {
      const { start, end } = serviceDateRange(input.serviceDate)
      const zone = await DeliveryZoneModel.findOne({ code: input.zoneCode, active: true }).lean()
      zoneNotFound = zone === null
      candidates = zone === null ? emptyCandidates : await getCandidates({ serviceDate: input.serviceDate, deliveryZoneId: String(zone._id) }, candidateContext)
      mapLocations = zone === null ? [] : await getMapLocations(zone._id, input.serviceDate, candidates)
      if (zone === null) {
        snapshotRead = []
      } else {
        snapshotRead = await RoutePlanModel.find({
          planningDate: { $gte: start, $lt: end },
          'zoneSnapshot.code': zone.code
        }).sort({ planningDate: 1, _id: 1 }).limit(MAX_DASHBOARD_SNAPSHOTS + 1).lean()
      }
    } else {
      candidates = await getGlobalCandidates(candidateContext)
      const mapLocationsRead = await getGlobalMapLocations(candidates)
      mapLocations = mapLocationsRead.locations
      mapLocationsTruncated = mapLocationsRead.truncated
      snapshotRead = await RoutePlanModel.find({}).sort({ planningDate: 1, _id: 1 }).limit(MAX_DASHBOARD_SNAPSHOTS + 1).lean()
    }

    if (zoneNotFound) {
      const result = {
        filters: input,
        kpis: { activeRoutes: 0, pendingOrders: 0, totalDistanceMeters: null, estimatedFuelLiters: null },
        routes: [],
        candidates: emptyCandidates,
        warnings: ['DELIVERY_ZONE_NOT_FOUND'],
        mapLocations: []
      }
      logDashboardEvent('route_dashboard_read', context, startedAt, 'ROUTE_ZONE_NOT_FOUND')
      return result
    }

    const snapshotsTruncated = snapshotRead.length > MAX_DASHBOARD_SNAPSHOTS
    const snapshots = snapshotsTruncated ? snapshotRead.slice(0, MAX_DASHBOARD_SNAPSHOTS) : snapshotRead
    const enrichedCandidates = enrichCandidatesWithRouteDistances(candidates, snapshots)
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
      ...(mapLocationsTruncated ? ['DASHBOARD_MAP_LOCATION_LIMIT_REACHED'] : []),
      ...(routes.length === 0 && enrichedCandidates.eligible.length === 0 && enrichedCandidates.blocked.length === 0 ? ['NO_DASHBOARD_DATA'] : [])
    ])]

    const result = {
      filters: input,
      kpis: {
        activeRoutes: routes.length,
        pendingOrders: enrichedCandidates.eligible.length,
        totalDistanceMeters,
        estimatedFuelLiters
      },
      routes,
      candidates: enrichedCandidates,
      warnings,
      mapLocations
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

export { MAX_CONCURRENT_DASHBOARD_READS, MAX_DASHBOARD_CANDIDATES, MAX_DASHBOARD_MAP_LOCATIONS, MAX_DASHBOARD_ROUTE_SALE_REFERENCES, MAX_DASHBOARD_ROUTE_STOPS, MAX_DASHBOARD_SNAPSHOTS, createConcurrencyLimiter, getDashboard }
