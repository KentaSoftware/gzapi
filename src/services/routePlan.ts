import { fromZonedTime } from 'date-fns-tz'
import { Types } from 'mongoose'
import { Client, GEOCODING_STATUS } from '../interfaces/client.interface'
import {
  CANDIDATE_BLOCK_REASONS,
  DEFAULT_ROUTE_ALGORITHM,
  ROUTE_METRIC_AVAILABILITY,
  ROUTING_CONFIG_KEYS,
  type BlockedCandidateEntry,
  type CandidateEntry,
  type CandidateQuery,
  type CandidateResult,
  type RouteLocation,
  type RoutePlan,
  type RoutePlanReadState,
  type RoutePreview,
  type RoutePreviewRequest,
  type RouteStop,
  type RoutingConfig,
  type RoutingConfigUpdateInput
} from '../interfaces/routeOptimization.interface'
import ClientModel from '../models/client'
import DeliveryZoneModel from '../models/deliveryZone'
import RoutingConfigModel from '../models/routingConfig'
import RoutePlanModel from '../models/routePlan'
import RoutePlanOperationalModel from '../models/routePlanOperational'
import SaleModel from '../models/sale'
import { buildClosedRoute, RouteInvariantError } from './routeHeuristic'
import { computeMatrix, computeRoute, RouteProviderError, type RouteMatrixDiagnostic } from './routeMatrixProvider'
import { calculateFuelLiters as calculateAssignedFuelLiters, resolveAssignedConsumption } from './routeFuel'
import { calculateStopEstimates } from './routeSchedule'
import { getVehicleById } from './vehicle'
import { detectStaleness } from './routeStaleness'

const CANDIDATE_RULE_VERSION = 'candidate-eligibility-v1'
const SERVICE_TIME_ZONE = 'America/Argentina/Buenos_Aires'
const STALE_ROUTE_WARNING = 'STALE_ROUTE_PLAN_REQUIRES_REPLANNING'

type RoutePreviewErrorCode = 'NO_ELIGIBLE_ORDERS' | 'CLIENT_LOCATION_MISSING' | 'CLIENT_LOCATION_AMBIGUOUS' | 'ROUTE_TECHNICAL_LIMIT_EXCEEDED' | 'ROUTE_MATRIX_INCOMPLETE' | 'ROUTING_PROVIDER_UNAVAILABLE' | 'ROUTING_PROVIDER_QUOTA_EXCEEDED' | 'INVALID_ROUTE_INPUT' | 'INVALID_CONFIGURATION' | 'ROUTE_ASSIGNMENT_REQUIRED'

interface RoutePlanRequestContext {
  correlationId?: string
}

interface RoutePlanEvent {
  event: 'route_plan_candidates_read_completed' | 'route_plan_candidates_read_failed' | 'route_plan_preview_completed' | 'route_plan_preview_failed' | 'route_plan_snapshot_saved' | 'route_plan_snapshot_save_failed' | 'route_plan_snapshot_read_completed' | 'route_plan_snapshot_read_failed' | 'route_plan_provider_completed' | 'route_plan_provider_failed' | 'route_plan_config_read_completed' | 'route_plan_config_read_failed' | 'route_plan_config_updated' | 'route_plan_config_update_failed'
  correlationId?: string
  latencyMs: number
  provider?: string
  providerOperation?: 'matrix' | 'route'
  algorithmVersion?: string
  ruleVersion?: string
  routingConfigRevision?: number
  resultCode: string
  diagnostic?: RouteMatrixDiagnostic
}

const logRoutePlanEvent = ({ event, correlationId, latencyMs, provider, providerOperation, algorithmVersion, ruleVersion, routingConfigRevision, resultCode, diagnostic }: RoutePlanEvent): void => {
  console.log(JSON.stringify({
    event,
    correlationId,
    latencyMs,
    provider,
    providerOperation,
    algorithmVersion,
    ruleVersion,
    routingConfigRevision,
    resultCode,
    diagnostic
  }))
}

class RoutePreviewError extends Error {
  readonly code: RoutePreviewErrorCode
  readonly diagnostic?: RouteMatrixDiagnostic

  constructor (code: RoutePreviewErrorCode, message: string, diagnostic?: RouteMatrixDiagnostic) {
    super(message)
    this.name = 'RoutePreviewError'
    this.code = code
    this.diagnostic = diagnostic
  }
}

const serviceDateRange = (serviceDate: string): { start: Date, end: Date } => {
  const [year, month, day] = serviceDate.split('-').map(Number)
  const nextCivilDate = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)

  return {
    start: fromZonedTime(`${serviceDate}T00:00:00`, SERVICE_TIME_ZONE),
    end: fromZonedTime(`${nextCivilDate}T00:00:00`, SERVICE_TIME_ZONE)
  }
}

const candidateEntry = (saleId: unknown, client: Client): CandidateEntry => ({
  saleId: String(saleId),
  clientId: String(client._id),
  displayName: client.nombreCompleto,
  addressSummary: client.address
})

const blockedCandidate = (saleId: unknown, reason: BlockedCandidateEntry['reasons'][number], client?: Client): BlockedCandidateEntry => {
  const result: BlockedCandidateEntry = { saleId: String(saleId), reasons: [reason] }
  if (client !== undefined) {
    result.clientId = String(client._id)
    result.displayName = client.nombreCompleto
    result.addressSummary = client.address
  }
  return result
}

const queryCandidates = async ({ serviceDate, deliveryZoneId }: CandidateQuery): Promise<CandidateResult> => {
  const { start, end } = serviceDateRange(serviceDate)
  const sales = await SaleModel.find({
    'delivery.status': 'PENDING',
    'delivery.serviceDate': { $gte: start, $lt: end }
  })
    .sort({ _id: 1 })
    .lean()

  const clientIds = sales
    .map((sale) => sale.idCliente === undefined ? undefined : String(sale.idCliente))
    .filter((id): id is string => id !== undefined && Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id))
  const clients = await ClientModel.find({ _id: { $in: clientIds } }).lean()
  const clientsById = new Map(clients.map((client) => [String(client._id), client]))

  const requestedZoneId = new Types.ObjectId(deliveryZoneId)
  const eligible: CandidateEntry[] = []
  const blocked: BlockedCandidateEntry[] = []

  for (const sale of sales) {
    const client = sale.idCliente === undefined ? undefined : clientsById.get(String(sale.idCliente))
    if (client === undefined) {
      blocked.push(blockedCandidate(sale._id, CANDIDATE_BLOCK_REASONS.INVALID_CLIENT_REFERENCE))
    } else if (client.isActive !== true) {
      blocked.push(blockedCandidate(sale._id, CANDIDATE_BLOCK_REASONS.CLIENT_INACTIVE, client))
    } else if (client.deliveryZoneId === undefined || !requestedZoneId.equals(client.deliveryZoneId)) {
      blocked.push(blockedCandidate(sale._id, CANDIDATE_BLOCK_REASONS.CLIENT_ZONE_MISMATCH, client))
    } else if (client.address === undefined || client.address.trim() === '' || client.lat === undefined || client.lng === undefined) {
      blocked.push(blockedCandidate(sale._id, CANDIDATE_BLOCK_REASONS.CLIENT_LOCATION_MISSING, client))
    } else if (client.geocoding?.status !== GEOCODING_STATUS.CONFIRMED) {
      blocked.push(blockedCandidate(sale._id, CANDIDATE_BLOCK_REASONS.CLIENT_LOCATION_UNCONFIRMED, client))
    } else {
      eligible.push(candidateEntry(sale._id, client))
    }
  }

  return { eligible, blocked, ruleVersion: CANDIDATE_RULE_VERSION }
}

const getCandidates = async (input: CandidateQuery, context: RoutePlanRequestContext = {}): Promise<CandidateResult> => {
  const start = Date.now()
  try {
    const result = await queryCandidates(input)
    logRoutePlanEvent({ event: 'route_plan_candidates_read_completed', correlationId: context.correlationId, latencyMs: Date.now() - start, ruleVersion: result.ruleVersion, resultCode: 'SUCCESS' })
    return result
  } catch (error) {
    logRoutePlanEvent({ event: 'route_plan_candidates_read_failed', correlationId: context.correlationId, latencyMs: Date.now() - start, ruleVersion: CANDIDATE_RULE_VERSION, resultCode: 'INTERNAL_ERROR' })
    throw error
  }
}

const getRoutingConfig = async (context: RoutePlanRequestContext = {}): Promise<RoutingConfig | null> => {
  const start = Date.now()
  try {
    const config = await RoutingConfigModel.findOne({ key: ROUTING_CONFIG_KEYS.DEPOSITO_1 })
    logRoutePlanEvent({ event: 'route_plan_config_read_completed', correlationId: context.correlationId, latencyMs: Date.now() - start, routingConfigRevision: config?.revision, resultCode: config === null ? 'ROUTE_CONFIG_NOT_FOUND' : 'SUCCESS' })
    return config
  } catch (error) {
    logRoutePlanEvent({ event: 'route_plan_config_read_failed', correlationId: context.correlationId, latencyMs: Date.now() - start, resultCode: 'INTERNAL_ERROR' })
    throw error
  }
}

const updateRoutingConfig = async (input: RoutingConfigUpdateInput, updatedBy: string, context: RoutePlanRequestContext = {}): Promise<RoutingConfig> => {
  const start = Date.now()
  try {
    const existing = await RoutingConfigModel.findOne({ key: ROUTING_CONFIG_KEYS.DEPOSITO_1 })
    const revision = existing === null ? 1 : existing.revision + 1
    const fields: Record<string, unknown> = {
      enabled: input.enabled ?? true,
      revision,
      depot: input.depot,
      provider: input.routeMode,
      algorithm: input.algorithm ?? existing?.algorithm ?? DEFAULT_ROUTE_ALGORITHM,
      updatedBy
    }
    if (input.fuelConsumptionLitersPer100Km !== undefined) fields.fuelConsumptionLitersPer100Km = input.fuelConsumptionLitersPer100Km
    if (input.maxStops !== undefined) fields.maxStops = input.maxStops
    const config = await RoutingConfigModel.findOneAndUpdate(
      { key: ROUTING_CONFIG_KEYS.DEPOSITO_1 },
      { $set: fields },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    )
    if (config === null) throw new Error('Routing configuration could not be persisted')
    logRoutePlanEvent({ event: 'route_plan_config_updated', correlationId: context.correlationId, latencyMs: Date.now() - start, provider: config.provider, algorithmVersion: config.algorithm, routingConfigRevision: config.revision, resultCode: 'SUCCESS' })
    return config
  } catch (error) {
    logRoutePlanEvent({ event: 'route_plan_config_update_failed', correlationId: context.correlationId, latencyMs: Date.now() - start, resultCode: 'INTERNAL_ERROR' })
    throw error
  }
}

const hasValidCoordinates = (latitude: unknown, longitude: unknown): latitude is number => typeof latitude === 'number' && typeof longitude === 'number' && Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180

const previewErrorForClient = (client: Client | undefined): RoutePreviewError | undefined => {
  if (client === undefined || client.isActive !== true) return new RoutePreviewError('NO_ELIGIBLE_ORDERS', 'Selected sales are not eligible for route planning')
  if (client.address === undefined || client.address.trim() === '' || !hasValidCoordinates(client.lat, client.lng)) return new RoutePreviewError('CLIENT_LOCATION_MISSING', 'A selected client is missing a confirmed location')
  if (client.geocoding?.status !== GEOCODING_STATUS.CONFIRMED) return new RoutePreviewError('CLIENT_LOCATION_AMBIGUOUS', 'A selected client location is not confirmed')
  return undefined
}

const previewProviderError = (error: unknown): RoutePreviewError => {
  if (error instanceof RoutePreviewError) return error
  if (error instanceof RouteInvariantError) return new RoutePreviewError(error.code, error.message)
  if (error instanceof RouteProviderError) {
    if (error.code === 'ROUTING_PROVIDER_QUOTA_EXCEEDED') return new RoutePreviewError(error.code, error.message, error.diagnostic)
    if (error.code === 'ROUTE_MATRIX_INCOMPLETE') return new RoutePreviewError(error.code, error.message, error.diagnostic)
    if (error.code === 'INVALID_ROUTE_INPUT') return new RoutePreviewError(error.code, error.message, error.diagnostic)
    return new RoutePreviewError('ROUTING_PROVIDER_UNAVAILABLE', error.message, error.diagnostic)
  }
  return new RoutePreviewError('ROUTING_PROVIDER_UNAVAILABLE', 'Routing provider is unavailable')
}

const providerDiagnostic = (error: unknown): RouteMatrixDiagnostic | undefined => {
  if (error instanceof RouteProviderError) return error.diagnostic
  if (error instanceof RoutePreviewError) return error.diagnostic
  return undefined
}

const errorCode = (error: unknown): string => error instanceof RoutePreviewError ? error.code : 'INTERNAL_ERROR'

const previewRoute = async (input: RoutePreviewRequest, context: RoutePlanRequestContext): Promise<RoutePreview> => {
  const { serviceDate, deliveryZoneId, saleIds, driverId, vehicleId } = input
  if (driverId === undefined && vehicleId === undefined) throw new RoutePreviewError('ROUTE_ASSIGNMENT_REQUIRED', 'driverId and vehicleId are required before preview or save')
  if (driverId === undefined) throw new RoutePreviewError('ROUTE_ASSIGNMENT_REQUIRED', 'driverId is required before preview or save')
  if (vehicleId === undefined) throw new RoutePreviewError('ROUTE_ASSIGNMENT_REQUIRED', 'vehicleId is required before preview or save')
  const { start, end } = serviceDateRange(serviceDate)
  const zone = await DeliveryZoneModel.findOne({ _id: deliveryZoneId, active: true }).lean()
  if (zone === null) throw new RoutePreviewError('NO_ELIGIBLE_ORDERS', 'The requested delivery zone is not active')

  const config = await RoutingConfigModel.findOne({ key: 'deposito_1', enabled: true }).lean()
  if (config === null || !hasValidCoordinates(config.depot?.latitude, config.depot?.longitude)) {
    throw new RoutePreviewError('INVALID_CONFIGURATION', 'Routing configuration is not valid for preview')
  }

  const selectedObjectIds = saleIds.map((saleId) => new Types.ObjectId(saleId))
  const sales = await SaleModel.find({ _id: { $in: selectedObjectIds } }).sort({ _id: 1 }).lean()
  if (sales.length !== saleIds.length) throw new RoutePreviewError('NO_ELIGIBLE_ORDERS', 'Selected sales are not eligible for route planning')

  const clientIds = sales
    .map((sale) => sale.idCliente === undefined ? undefined : String(sale.idCliente))
    .filter((id): id is string => id !== undefined && Types.ObjectId.isValid(id))
  const clients = await ClientModel.find({ _id: { $in: clientIds } }).lean()
  const clientsById = new Map(clients.map((client) => [String(client._id), client]))
  const stopsByClient = new Map<string, RouteStop>()

  for (const sale of sales) {
    if (sale.delivery?.status !== 'PENDING' || sale.delivery.serviceDate === undefined || sale.delivery.serviceDate < start || sale.delivery.serviceDate >= end || sale.idCliente === undefined) {
      throw new RoutePreviewError('NO_ELIGIBLE_ORDERS', 'Selected sales are not eligible for route planning')
    }
    const client = clientsById.get(String(sale.idCliente))
    const clientError = previewErrorForClient(client)
    if (clientError !== undefined) throw clientError
    if (client === undefined) throw new RoutePreviewError('NO_ELIGIBLE_ORDERS', 'Selected sales are not eligible for route planning')
    if (client.deliveryZoneId === undefined || String(client.deliveryZoneId) !== deliveryZoneId) {
      throw new RoutePreviewError('NO_ELIGIBLE_ORDERS', 'Selected sales are not eligible for the requested delivery zone')
    }
    const clientId = String(client._id)
    const stop = stopsByClient.get(clientId)
    if (stop === undefined) {
      stopsByClient.set(clientId, { clientId, saleIds: [String(sale._id)], latitude: client.lat as number, longitude: client.lng as number })
    } else {
      stop.saleIds.push(String(sale._id))
    }
  }

  const depot: RouteLocation = { id: 'deposito_1', name: config.depot.name, latitude: config.depot.latitude, longitude: config.depot.longitude }
  const stops = [...stopsByClient.values()]
  if (typeof config.maxStops === 'number' && Number.isFinite(config.maxStops) && stops.length > config.maxStops) {
    throw new RoutePreviewError('ROUTE_TECHNICAL_LIMIT_EXCEEDED', `Route preview exceeds the configured maximum of ${config.maxStops} stops`)
  }
  const locations: RouteLocation[] = [depot, ...stops.map((stop) => {
    const client = clientsById.get(stop.clientId)
    return { id: stop.clientId, name: client?.nombreCompleto ?? stop.clientId, latitude: stop.latitude, longitude: stop.longitude }
  })]

  try {
    const matrixStart = Date.now()
    let matrix
    try {
      matrix = await computeMatrix({ origins: locations, destinations: locations })
      logRoutePlanEvent({ event: 'route_plan_provider_completed', correlationId: context.correlationId, latencyMs: Date.now() - matrixStart, provider: config.provider, providerOperation: 'matrix', algorithmVersion: config.algorithm, ruleVersion: CANDIDATE_RULE_VERSION, routingConfigRevision: config.revision, resultCode: 'SUCCESS' })
    } catch (error) {
      const mapped = previewProviderError(error)
      logRoutePlanEvent({ event: 'route_plan_provider_failed', correlationId: context.correlationId, latencyMs: Date.now() - matrixStart, provider: config.provider, providerOperation: 'matrix', algorithmVersion: config.algorithm, ruleVersion: CANDIDATE_RULE_VERSION, routingConfigRevision: config.revision, resultCode: errorCode(mapped), diagnostic: providerDiagnostic(mapped) })
      throw error
    }
    const heuristic = buildClosedRoute({ depot, stops, matrix: matrix.segments })
    const intermediates = heuristic.orderedStops.map((stop) => {
      const client = clientsById.get(stop.clientId)
      return { id: stop.clientId, name: client?.nombreCompleto ?? stop.clientId, latitude: stop.latitude, longitude: stop.longitude }
    })
    const routeStart = Date.now()
    let finalRoute
    try {
      finalRoute = await computeRoute({
        origin: depot,
        intermediates,
        destination: depot
      })
      logRoutePlanEvent({ event: 'route_plan_provider_completed', correlationId: context.correlationId, latencyMs: Date.now() - routeStart, provider: config.provider, providerOperation: 'route', algorithmVersion: config.algorithm, ruleVersion: CANDIDATE_RULE_VERSION, routingConfigRevision: config.revision, resultCode: 'SUCCESS' })
    } catch (error) {
      const mapped = previewProviderError(error)
      logRoutePlanEvent({ event: 'route_plan_provider_failed', correlationId: context.correlationId, latencyMs: Date.now() - routeStart, provider: config.provider, providerOperation: 'route', algorithmVersion: config.algorithm, ruleVersion: CANDIDATE_RULE_VERSION, routingConfigRevision: config.revision, resultCode: errorCode(mapped), diagnostic: providerDiagnostic(mapped) })
      throw error
    }
    const calculatedAt = new Date()
    const timezone = SERVICE_TIME_ZONE
    const vehicle = await getVehicleById(vehicleId)
    const consumption = resolveAssignedConsumption(vehicle)
    const distanceKm = finalRoute.distanceMeters / 1000
    const fuelAvailable = consumption !== null
    const fuelLiters = fuelAvailable ? calculateAssignedFuelLiters(distanceKm, consumption) : null
    const routeForSchedule: RoutePreview = {
      route: { depot, stops: heuristic.orderedStops, segments: heuristic.segments, encodedPolyline: finalRoute.encodedPolyline },
      metrics: { distanceMeters: finalRoute.distanceMeters, durationSeconds: finalRoute.durationSeconds, stopCount: heuristic.orderedStops.length, fuelLiters, availability: fuelAvailable ? ROUTE_METRIC_AVAILABILITY.CALCULATED : ROUTE_METRIC_AVAILABILITY.UNAVAILABLE },
      assignments: { driverId, vehicleId },
      fuelAssumptions: { availability: fuelAvailable ? ROUTE_METRIC_AVAILABILITY.CALCULATED : ROUTE_METRIC_AVAILABILITY.UNAVAILABLE, consumptionLitersPer100Km: consumption, distanceKm, vehicleCode: vehicle?.code ?? null, source: 'assigned-vehicle', calculatedAt },
      scheduleAssumptions: { calculatedAt, timezone, source: 'system-clock' },
      stopEstimates: [],
      saleReferences: sales.map((sale) => ({ saleId: String(sale._id), versionAtSave: (sale as unknown as { updatedAt?: Date }).updatedAt?.getTime() ?? null, statusAtSave: sale.delivery?.status ?? null })),
      warnings: fuelAvailable ? ['TIME_WINDOWS_NOT_CONSIDERED'] : ['TIME_WINDOWS_NOT_CONSIDERED', 'FUEL_UNAVAILABLE'],
      factorsConsidered: ['DISTANCE', 'DURATION', 'FUEL_CONSUMPTION'],
      algorithmVersion: config.algorithm,
      algorithmProvider: config.provider,
      routingConfigRevision: config.revision,
      ruleVersion: CANDIDATE_RULE_VERSION
    }
    routeForSchedule.stopEstimates = calculateStopEstimates(routeForSchedule, calculatedAt, timezone)
    return {
      route: { depot, stops: heuristic.orderedStops, segments: heuristic.segments, encodedPolyline: finalRoute.encodedPolyline },
      metrics: routeForSchedule.metrics,
      assignments: routeForSchedule.assignments,
      fuelAssumptions: routeForSchedule.fuelAssumptions,
      scheduleAssumptions: routeForSchedule.scheduleAssumptions,
      stopEstimates: routeForSchedule.stopEstimates,
      saleReferences: routeForSchedule.saleReferences,
      warnings: routeForSchedule.warnings,
      factorsConsidered: routeForSchedule.factorsConsidered,
      algorithmVersion: config.algorithm,
      algorithmProvider: config.provider,
      routingConfigRevision: config.revision,
      ruleVersion: CANDIDATE_RULE_VERSION
    }
  } catch (error) {
    throw previewProviderError(error)
  }
}

const preview = async (input: RoutePreviewRequest, context: RoutePlanRequestContext = {}): Promise<RoutePreview> => {
  const start = Date.now()
  try {
    const result = await previewRoute(input, context)
    logRoutePlanEvent({ event: 'route_plan_preview_completed', correlationId: context.correlationId, latencyMs: Date.now() - start, provider: result.algorithmProvider, algorithmVersion: result.algorithmVersion, ruleVersion: result.ruleVersion, routingConfigRevision: result.routingConfigRevision, resultCode: 'SUCCESS' })
    return result
  } catch (error) {
    const mapped = previewProviderError(error)
    logRoutePlanEvent({ event: 'route_plan_preview_failed', correlationId: context.correlationId, latencyMs: Date.now() - start, ruleVersion: CANDIDATE_RULE_VERSION, resultCode: errorCode(mapped), diagnostic: providerDiagnostic(mapped) })
    throw error
  }
}

const saveSnapshot = async (input: RoutePreviewRequest, createdBy: string, context: RoutePlanRequestContext = {}): Promise<RoutePlan> => {
  const start = Date.now()
  try {
    const result = await preview(input, context)
    const zone = await DeliveryZoneModel.findOne({ _id: input.deliveryZoneId, active: true }).lean()
    if (zone === null) throw new RoutePreviewError('NO_ELIGIBLE_ORDERS', 'The requested delivery zone is not active')
    const stopSequenceByClientId = new Map(result.route.stops.map((stop, index) => [stop.clientId, index + 1]))
    const snapshot: RoutePlan = {
      snapshotVersion: 1,
      planningDate: serviceDateRange(input.serviceDate).start,
      zoneSnapshot: {
        code: zone.code,
        normalizedName: zone.normalizedName,
        name: zone.name
      },
      selectedSaleIds: [...input.saleIds],
      depot: {
        name: result.route.depot.name,
        latitude: result.route.depot.latitude,
        longitude: result.route.depot.longitude
      },
      stops: result.route.stops.map((stop, index) => ({
        clientId: stop.clientId,
        saleIds: [...stop.saleIds],
        sequence: index + 1,
        latitude: stop.latitude,
        longitude: stop.longitude
      })),
      segments: result.route.segments.map((segment) => ({
        fromStopSequence: segment.fromId === 'deposito_1' ? 0 : stopSequenceByClientId.get(segment.fromId) as number,
        toStopSequence: segment.toId === 'deposito_1' ? 0 : stopSequenceByClientId.get(segment.toId) as number,
        distanceMeters: segment.distanceMeters,
        durationSeconds: segment.durationSeconds
      })),
      metrics: { ...result.metrics, fuelLiters: result.metrics.fuelLiters ?? undefined },
      assignments: result.assignments,
      fuelAssumptions: result.fuelAssumptions,
      scheduleAssumptions: result.scheduleAssumptions,
      stopEstimates: result.stopEstimates,
      saleReferences: result.saleReferences,
      algorithm: {
        name: result.algorithmVersion,
        version: result.algorithmVersion,
        provider: result.algorithmProvider
      },
      routingConfigRevision: result.routingConfigRevision,
      ruleVersion: result.ruleVersion,
      encodedPolyline: result.route.encodedPolyline,
      warnings: result.warnings,
      audit: { createdBy, createdAt: new Date() }
    }
    const saved = await RoutePlanModel.create(snapshot)
    logRoutePlanEvent({ event: 'route_plan_snapshot_saved', correlationId: context.correlationId, latencyMs: Date.now() - start, provider: result.algorithmProvider, algorithmVersion: result.algorithmVersion, ruleVersion: result.ruleVersion, routingConfigRevision: result.routingConfigRevision, resultCode: 'SUCCESS' })
    return saved
  } catch (error) {
    logRoutePlanEvent({ event: 'route_plan_snapshot_save_failed', correlationId: context.correlationId, latencyMs: Date.now() - start, ruleVersion: CANDIDATE_RULE_VERSION, resultCode: errorCode(previewProviderError(error)) })
    throw error
  }
}

const readState = async (snapshot: RoutePlan): Promise<RoutePlanReadState> => {
  if (snapshot.saleReferences === undefined || snapshot.saleReferences.length === 0) {
    return { staleness: null, readWarnings: [] }
  }

  const saleIds = snapshot.saleReferences
    .map((reference) => reference.saleId)
    .filter((saleId) => Types.ObjectId.isValid(saleId))
    .map((saleId) => new Types.ObjectId(saleId))
  const currentSales = saleIds.length === 0
    ? []
    : await SaleModel.find(
      { _id: { $in: saleIds } },
      { _id: 1, updatedAt: 1, estado: 1, delivery: 1 }
    ).lean()
  const staleness = detectStaleness(snapshot, currentSales)
  await RoutePlanOperationalModel.updateOne(
    { snapshotId: String(snapshot._id) },
    {
      $set: {
        stale: staleness.stale,
        staleCauses: staleness.causes,
        staleDetectedAt: staleness.detectedAt
      }
    }
  )
  return {
    staleness,
    readWarnings: staleness.stale ? [STALE_ROUTE_WARNING] : []
  }
}

const withReadState = async (snapshot: RoutePlan): Promise<RoutePlan> => ({
  ...snapshot,
  ...(await readState(snapshot))
})

const listSnapshots = async (context: RoutePlanRequestContext = {}): Promise<RoutePlan[]> => {
  const start = Date.now()
  try {
    const snapshots = await RoutePlanModel.find({}).sort({ createdAt: -1, _id: -1 }).lean()
    const snapshotsWithReadState = await Promise.all(snapshots.map(withReadState))
    logRoutePlanEvent({ event: 'route_plan_snapshot_read_completed', correlationId: context.correlationId, latencyMs: Date.now() - start, resultCode: 'SUCCESS' })
    return snapshotsWithReadState
  } catch (error) {
    logRoutePlanEvent({ event: 'route_plan_snapshot_read_failed', correlationId: context.correlationId, latencyMs: Date.now() - start, resultCode: 'INTERNAL_ERROR' })
    throw error
  }
}

const getSnapshot = async (id: string, context: RoutePlanRequestContext = {}): Promise<RoutePlan | null> => {
  const start = Date.now()
  try {
    const snapshot = await RoutePlanModel.findById(id).lean()
    const snapshotWithReadState = snapshot === null ? null : await withReadState(snapshot)
    logRoutePlanEvent({ event: 'route_plan_snapshot_read_completed', correlationId: context.correlationId, latencyMs: Date.now() - start, resultCode: snapshot === null ? 'ROUTE_PLAN_NOT_FOUND' : 'SUCCESS' })
    return snapshotWithReadState
  } catch (error) {
    logRoutePlanEvent({ event: 'route_plan_snapshot_read_failed', correlationId: context.correlationId, latencyMs: Date.now() - start, resultCode: 'INTERNAL_ERROR' })
    throw error
  }
}

export { CANDIDATE_RULE_VERSION, getCandidates, getRoutingConfig, updateRoutingConfig, preview, saveSnapshot, listSnapshots, getSnapshot, RoutePreviewError, logRoutePlanEvent }
