import { fromZonedTime } from 'date-fns-tz'
import { Types } from 'mongoose'
import { Client, GEOCODING_STATUS } from '../interfaces/client.interface'
import {
  CANDIDATE_BLOCK_REASONS,
  CandidateEntry,
  CandidateQuery,
  CandidateResult,
  BlockedCandidateEntry
} from '../interfaces/routeOptimization.interface'
import ClientModel from '../models/client'
import DeliveryZoneModel from '../models/deliveryZone'
import RoutingConfigModel from '../models/routingConfig'
import RoutePlanModel from '../models/routePlan'
import SaleModel from '../models/sale'
import { buildClosedRoute, calculateFuelLiters, RouteInvariantError } from './routeHeuristic'
import { computeMatrix, computeRoute, RouteProviderError } from './routeMatrixProvider'
import type { RouteLocation, RoutePlan, RoutePreview, RoutePreviewRequest, RouteStop } from '../interfaces/routeOptimization.interface'

const CANDIDATE_RULE_VERSION = 'candidate-eligibility-v1'
const SERVICE_TIME_ZONE = 'America/Argentina/Buenos_Aires'

type RoutePreviewErrorCode = 'NO_ELIGIBLE_ORDERS' | 'CLIENT_LOCATION_MISSING' | 'CLIENT_LOCATION_AMBIGUOUS' | 'ROUTE_TECHNICAL_LIMIT_EXCEEDED' | 'ROUTE_MATRIX_INCOMPLETE' | 'ROUTING_PROVIDER_UNAVAILABLE' | 'ROUTING_PROVIDER_QUOTA_EXCEEDED' | 'INVALID_ROUTE_INPUT' | 'INVALID_CONFIGURATION'

interface RoutePlanRequestContext {
  correlationId?: string
}

interface RoutePlanEvent {
  event: 'route_plan_candidates_read_completed' | 'route_plan_candidates_read_failed' | 'route_plan_preview_completed' | 'route_plan_preview_failed' | 'route_plan_snapshot_saved' | 'route_plan_snapshot_save_failed' | 'route_plan_snapshot_read_completed' | 'route_plan_snapshot_read_failed' | 'route_plan_provider_completed' | 'route_plan_provider_failed'
  correlationId?: string
  latencyMs: number
  provider?: string
  providerOperation?: 'matrix' | 'route'
  algorithmVersion?: string
  ruleVersion?: string
  routingConfigRevision?: number
  resultCode: string
}

const logRoutePlanEvent = ({ event, correlationId, latencyMs, provider, providerOperation, algorithmVersion, ruleVersion, routingConfigRevision, resultCode }: RoutePlanEvent): void => {
  console.log(JSON.stringify({
    event,
    correlationId,
    latencyMs,
    provider,
    providerOperation,
    algorithmVersion,
    ruleVersion,
    routingConfigRevision,
    resultCode
  }))
}

class RoutePreviewError extends Error {
  readonly code: RoutePreviewErrorCode

  constructor (code: RoutePreviewErrorCode, message: string) {
    super(message)
    this.name = 'RoutePreviewError'
    this.code = code
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
    if (error.code === 'ROUTING_PROVIDER_QUOTA_EXCEEDED') return new RoutePreviewError(error.code, error.message)
    if (error.code === 'ROUTE_MATRIX_INCOMPLETE') return new RoutePreviewError(error.code, error.message)
    if (error.code === 'INVALID_ROUTE_INPUT') return new RoutePreviewError(error.code, error.message)
    return new RoutePreviewError('ROUTING_PROVIDER_UNAVAILABLE', error.message)
  }
  return new RoutePreviewError('ROUTING_PROVIDER_UNAVAILABLE', 'Routing provider is unavailable')
}

const errorCode = (error: unknown): string => error instanceof RoutePreviewError ? error.code : 'INTERNAL_ERROR'

const previewRoute = async ({ serviceDate, deliveryZoneId, saleIds }: RoutePreviewRequest, context: RoutePlanRequestContext): Promise<RoutePreview> => {
  const { start, end } = serviceDateRange(serviceDate)
  const zone = await DeliveryZoneModel.findOne({ _id: deliveryZoneId, active: true }).lean()
  if (zone === null) throw new RoutePreviewError('NO_ELIGIBLE_ORDERS', 'The requested delivery zone is not active')

  const config = await RoutingConfigModel.findOne({ key: 'deposito_1', enabled: true }).lean()
  if (config === null || !hasValidCoordinates(config.depot?.latitude, config.depot?.longitude) || typeof config.fuelConsumptionLitersPer100Km !== 'number' || !Number.isFinite(config.fuelConsumptionLitersPer100Km) || config.fuelConsumptionLitersPer100Km < 0) {
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
      logRoutePlanEvent({ event: 'route_plan_provider_failed', correlationId: context.correlationId, latencyMs: Date.now() - matrixStart, provider: config.provider, providerOperation: 'matrix', algorithmVersion: config.algorithm, ruleVersion: CANDIDATE_RULE_VERSION, routingConfigRevision: config.revision, resultCode: errorCode(previewProviderError(error)) })
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
      logRoutePlanEvent({ event: 'route_plan_provider_failed', correlationId: context.correlationId, latencyMs: Date.now() - routeStart, provider: config.provider, providerOperation: 'route', algorithmVersion: config.algorithm, ruleVersion: CANDIDATE_RULE_VERSION, routingConfigRevision: config.revision, resultCode: errorCode(previewProviderError(error)) })
      throw error
    }
    return {
      route: { depot, stops: heuristic.orderedStops, segments: heuristic.segments, encodedPolyline: finalRoute.encodedPolyline },
      metrics: { distanceMeters: finalRoute.distanceMeters, durationSeconds: finalRoute.durationSeconds, stopCount: heuristic.orderedStops.length, fuelLiters: calculateFuelLiters(finalRoute.distanceMeters / 1000, config.fuelConsumptionLitersPer100Km) },
      warnings: ['TIME_WINDOWS_NOT_CONSIDERED'],
      factorsConsidered: ['DISTANCE', 'DURATION', 'FUEL_CONSUMPTION'],
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
    logRoutePlanEvent({ event: 'route_plan_preview_failed', correlationId: context.correlationId, latencyMs: Date.now() - start, ruleVersion: CANDIDATE_RULE_VERSION, resultCode: errorCode(previewProviderError(error)) })
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
      metrics: result.metrics,
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

const listSnapshots = async (context: RoutePlanRequestContext = {}): Promise<RoutePlan[]> => {
  const start = Date.now()
  try {
    const snapshots = await RoutePlanModel.find({}).sort({ createdAt: -1, _id: -1 }).lean()
    logRoutePlanEvent({ event: 'route_plan_snapshot_read_completed', correlationId: context.correlationId, latencyMs: Date.now() - start, resultCode: 'SUCCESS' })
    return snapshots
  } catch (error) {
    logRoutePlanEvent({ event: 'route_plan_snapshot_read_failed', correlationId: context.correlationId, latencyMs: Date.now() - start, resultCode: 'INTERNAL_ERROR' })
    throw error
  }
}

const getSnapshot = async (id: string, context: RoutePlanRequestContext = {}): Promise<RoutePlan | null> => {
  const start = Date.now()
  try {
    const snapshot = await RoutePlanModel.findById(id).lean()
    logRoutePlanEvent({ event: 'route_plan_snapshot_read_completed', correlationId: context.correlationId, latencyMs: Date.now() - start, resultCode: snapshot === null ? 'ROUTE_PLAN_NOT_FOUND' : 'SUCCESS' })
    return snapshot
  } catch (error) {
    logRoutePlanEvent({ event: 'route_plan_snapshot_read_failed', correlationId: context.correlationId, latencyMs: Date.now() - start, resultCode: 'INTERNAL_ERROR' })
    throw error
  }
}

export { CANDIDATE_RULE_VERSION, getCandidates, preview, saveSnapshot, listSnapshots, getSnapshot, RoutePreviewError, logRoutePlanEvent }
