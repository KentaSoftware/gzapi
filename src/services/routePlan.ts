import { fromZonedTime } from 'date-fns-tz'
import { createHash, randomBytes } from 'crypto'
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
  type RoutePreviewDepot,
  type RoutePlan,
  type RoutePlanOperational,
  type RoutePlanReadState,
  type RouteAssignmentOptions,
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
import RoutePlanPreviewReceiptModel from '../models/routePlanPreviewReceipt'
import RoutePlanOperationalModel from '../models/routePlanOperational'
import SaleModel from '../models/sale'
import ItemSaleModel from '../models/itemSale'
import { buildClosedRoute, RouteInvariantError, validateClientOrder } from './routeHeuristic'
import { computeMatrix, computeRoute, RouteProviderError, type RouteMatrixDiagnostic } from './routeMatrixProvider'
import { calculateFuelLiters as calculateAssignedFuelLiters, resolveAssignedConsumption } from './routeFuel'
import { calculateStopEstimates } from './routeSchedule'
import { getVehicleById, listSelectableVehicles } from './vehicle'
import { getAllUsers } from './user'
import { detectStaleness } from './routeStaleness'

const CANDIDATE_RULE_VERSION = 'candidate-eligibility-v1'
const SERVICE_TIME_ZONE = 'America/Argentina/Buenos_Aires'
const STALE_ROUTE_WARNING = 'STALE_ROUTE_PLAN_REQUIRES_REPLANNING'
const MAX_CANDIDATE_READS = 1000
const MAX_SNAPSHOT_LIST_READS = 100
const CANCELLED_SALE_PATTERN = /^\s*cancelado\s*$/i
const hasValidCoordinates = (latitude: unknown, longitude: unknown): latitude is number => typeof latitude === 'number' && typeof longitude === 'number' && Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180

type RoutePreviewErrorCode = 'NO_ELIGIBLE_ORDERS' | 'CLIENT_LOCATION_MISSING' | 'CLIENT_LOCATION_AMBIGUOUS' | 'ROUTE_TECHNICAL_LIMIT_EXCEEDED' | 'ROUTE_MATRIX_INCOMPLETE' | 'ROUTING_PROVIDER_UNAVAILABLE' | 'ROUTING_PROVIDER_QUOTA_EXCEEDED' | 'INVALID_ROUTE_INPUT' | 'INVALID_CONFIGURATION' | 'ROUTE_ASSIGNMENT_REQUIRED' | 'PREVIEW_RECEIPT_CONFLICT'

interface RoutePlanRequestContext {
  correlationId?: string
  maxResults?: number
  truncated?: boolean
  driverId?: string
  actor?: string
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
  addressSummary: client.address,
  ...(Number.isFinite(client.lat) ? { latitude: client.lat } : {}),
  ...(Number.isFinite(client.lng) ? { longitude: client.lng } : {})
})

const blockedCandidate = (saleId: unknown, reason: BlockedCandidateEntry['reasons'][number], client?: Client): BlockedCandidateEntry => {
  const result: BlockedCandidateEntry = { saleId: String(saleId), reasons: [reason] }
  if (client !== undefined) {
    result.clientId = String(client._id)
    result.displayName = client.nombreCompleto
    result.addressSummary = client.address
    if (Number.isFinite(client.lat)) result.latitude = client.lat
    if (Number.isFinite(client.lng)) result.longitude = client.lng
  }
  return result
}

interface CandidateQueryResult {
  result: CandidateResult
  truncated: boolean
}

const queryGlobalCandidates = async (maxResults?: number): Promise<CandidateQueryResult> => {
  const salesQuery = SaleModel.find({ 'delivery.status': 'PENDING', estado: { $not: CANCELLED_SALE_PATTERN } }).sort({ _id: 1 })
  const sales = await (maxResults === undefined ? salesQuery : salesQuery.limit(maxResults + 1)).lean()
  const boundedSales = maxResults === undefined || sales.length <= maxResults ? sales : sales.slice(0, maxResults)
  const clientIds = boundedSales
    .map((sale) => sale.idCliente === undefined ? undefined : String(sale.idCliente))
    .filter((id): id is string => id !== undefined && Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id))
  const clients = await ClientModel.find({ _id: { $in: clientIds } }).lean()
  const clientsById = new Map(clients.map((client) => [String(client._id), client]))
  const eligible: CandidateEntry[] = []
  const blocked: BlockedCandidateEntry[] = []

  for (const sale of boundedSales) {
    const client = sale.idCliente === undefined ? undefined : clientsById.get(String(sale.idCliente))
    if (client === undefined) blocked.push(blockedCandidate(sale._id, CANDIDATE_BLOCK_REASONS.INVALID_CLIENT_REFERENCE))
    else if (client.isActive !== true) blocked.push(blockedCandidate(sale._id, CANDIDATE_BLOCK_REASONS.CLIENT_INACTIVE, client))
    else if (client.address === undefined || client.address.trim() === '' || !hasValidCoordinates(client.lat, client.lng)) blocked.push(blockedCandidate(sale._id, CANDIDATE_BLOCK_REASONS.CLIENT_LOCATION_MISSING, client))
    else if (client.geocoding?.status !== GEOCODING_STATUS.CONFIRMED) blocked.push(blockedCandidate(sale._id, CANDIDATE_BLOCK_REASONS.CLIENT_LOCATION_UNCONFIRMED, client))
    else eligible.push(candidateEntry(sale._id, client))
  }

  return {
    result: { eligible, blocked, ruleVersion: CANDIDATE_RULE_VERSION },
    truncated: maxResults !== undefined && sales.length > maxResults
  }
}

const queryCandidates = async ({ serviceDate, deliveryZoneId }: CandidateQuery, maxResults?: number): Promise<CandidateQueryResult> => {
  const { start, end } = serviceDateRange(serviceDate)
  const salesQuery = SaleModel.find({
    'delivery.status': 'PENDING',
    estado: { $not: CANCELLED_SALE_PATTERN },
    'delivery.serviceDate': { $gte: start, $lt: end }
  })
    .sort({ _id: 1 })
  const sales = await (maxResults === undefined ? salesQuery : salesQuery.limit(maxResults + 1)).lean()
  const boundedSales = maxResults === undefined || sales.length <= maxResults ? sales : sales.slice(0, maxResults)

  const clientIds = boundedSales
    .map((sale) => sale.idCliente === undefined ? undefined : String(sale.idCliente))
    .filter((id): id is string => id !== undefined && Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id))
  const clients = await ClientModel.find({ _id: { $in: clientIds } }).lean()
  const clientsById = new Map(clients.map((client) => [String(client._id), client]))
  const requestedZoneId = new Types.ObjectId(deliveryZoneId)
  const eligible: CandidateEntry[] = []
  const blocked: BlockedCandidateEntry[] = []

  for (const sale of boundedSales) {
    const client = sale.idCliente === undefined ? undefined : clientsById.get(String(sale.idCliente))
    if (client === undefined) {
      blocked.push(blockedCandidate(sale._id, CANDIDATE_BLOCK_REASONS.INVALID_CLIENT_REFERENCE))
    } else if (client.isActive !== true) {
      blocked.push(blockedCandidate(sale._id, CANDIDATE_BLOCK_REASONS.CLIENT_INACTIVE, client))
    } else if (client.deliveryZoneId === undefined || !requestedZoneId.equals(client.deliveryZoneId)) {
      blocked.push(blockedCandidate(sale._id, CANDIDATE_BLOCK_REASONS.CLIENT_ZONE_MISMATCH, client))
    } else if (client.address === undefined || client.address.trim() === '' || !hasValidCoordinates(client.lat, client.lng)) {
      blocked.push(blockedCandidate(sale._id, CANDIDATE_BLOCK_REASONS.CLIENT_LOCATION_MISSING, client))
    } else if (client.geocoding?.status !== GEOCODING_STATUS.CONFIRMED) {
      blocked.push(blockedCandidate(sale._id, CANDIDATE_BLOCK_REASONS.CLIENT_LOCATION_UNCONFIRMED, client))
    } else {
      eligible.push(candidateEntry(sale._id, client))
    }
  }

  return {
    result: { eligible, blocked, ruleVersion: CANDIDATE_RULE_VERSION },
    truncated: maxResults !== undefined && sales.length > maxResults
  }
}

const getCandidates = async (input: CandidateQuery, context: RoutePlanRequestContext = {}): Promise<CandidateResult> => {
  const start = Date.now()
  try {
    const queryResult = await queryCandidates(input, context.maxResults)
    context.truncated = queryResult.truncated
    logRoutePlanEvent({ event: 'route_plan_candidates_read_completed', correlationId: context.correlationId, latencyMs: Date.now() - start, ruleVersion: queryResult.result.ruleVersion, resultCode: 'SUCCESS' })
    return queryResult.result
  } catch (error) {
    logRoutePlanEvent({ event: 'route_plan_candidates_read_failed', correlationId: context.correlationId, latencyMs: Date.now() - start, ruleVersion: CANDIDATE_RULE_VERSION, resultCode: 'INTERNAL_ERROR' })
    throw error
  }
}

const getGlobalCandidates = async (context: RoutePlanRequestContext = {}): Promise<CandidateResult> => {
  const start = Date.now()
  try {
    const queryResult = await queryGlobalCandidates(context.maxResults)
    context.truncated = queryResult.truncated
    logRoutePlanEvent({ event: 'route_plan_candidates_read_completed', correlationId: context.correlationId, latencyMs: Date.now() - start, ruleVersion: queryResult.result.ruleVersion, resultCode: 'SUCCESS' })
    return queryResult.result
  } catch (error) {
    logRoutePlanEvent({ event: 'route_plan_candidates_read_failed', correlationId: context.correlationId, latencyMs: Date.now() - start, ruleVersion: CANDIDATE_RULE_VERSION, resultCode: 'INTERNAL_ERROR' })
    throw error
  }
}

interface AssignmentUserSource {
  _id?: unknown
  nickname?: unknown
  isActive?: unknown
}

const getAssignmentOptions = async (): Promise<RouteAssignmentOptions> => {
  const users = await getAllUsers() as unknown[]
  const drivers = users.map((user): RouteAssignmentOptions['drivers'][number] => {
    const source = user as AssignmentUserSource
    return {
      id: String(source._id),
      nickname: String(source.nickname),
      isActive: source.isActive === true
    }
  })

  return {
    drivers,
    vehicles: await listSelectableVehicles()
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
      depot: {
        ...input.depot,
        ...(input.depot.address === undefined && existing?.depot.address !== undefined
          ? { address: existing.depot.address }
          : {})
      },
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
  if (sales.some((sale) => typeof sale.estado === 'string' && CANCELLED_SALE_PATTERN.test(sale.estado))) {
    throw new RoutePreviewError('NO_ELIGIBLE_ORDERS', 'Cancelled sales are not eligible for route planning')
  }

  const clientIds = sales
    .map((sale) => sale.idCliente === undefined ? undefined : String(sale.idCliente))
    .filter((id): id is string => id !== undefined && Types.ObjectId.isValid(id))
  const clients = await ClientModel.find({ _id: { $in: clientIds } }).lean()
  const clientsById = new Map(clients.map((client) => [String(client._id), client]))
  const stopsByClient = new Map<string, RouteStop>()
  const itemSales = await ItemSaleModel.find({
    idVenta: { $in: selectedObjectIds },
    $or: [{ estado: true }, { estado: { $exists: false } }]
  }).lean()
  const itemSummaryBySale = new Map<string, { itemCount: number, productIds: Set<string>, unitCount: number }>()
  for (const item of itemSales) {
    const saleId = String(item.idVenta)
    const summary = itemSummaryBySale.get(saleId) ?? { itemCount: 0, productIds: new Set<string>(), unitCount: 0 }
    summary.itemCount += 1
    summary.productIds.add(String(item.idProducto))
    summary.unitCount += item.cantidad
    itemSummaryBySale.set(saleId, summary)
  }

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

  const depot: RoutePreviewDepot = {
    id: 'deposito_1',
    name: config.depot.name,
    latitude: config.depot.latitude,
    longitude: config.depot.longitude,
    ...(config.depot.address === undefined ? {} : { address: config.depot.address })
  }
  const stops = [...stopsByClient.values()]
  if (input.clientOrder !== undefined) {
    try { validateClientOrder(stops, input.clientOrder) } catch (error) { throw previewProviderError(error) }
  }
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
    const heuristic = buildClosedRoute({ depot, stops, matrix: matrix.segments, clientOrder: input.clientOrder })
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
      saleReferences: saleIds.map((saleId) => {
        const sale = sales.find((candidate) => String(candidate._id) === saleId) as typeof sales[number]
        const client = sale.idCliente === undefined ? undefined : clientsById.get(String(sale.idCliente))
        const itemSummary = itemSummaryBySale.get(saleId)
        const itemFields: { itemCount?: number, productCount?: number, unitCount?: number } = {}
        if (itemSummary !== undefined) {
          itemFields.itemCount = itemSummary.itemCount
          itemFields.productCount = itemSummary.productIds.size
          itemFields.unitCount = itemSummary.unitCount
        }
        return {
          saleId,
          versionAtSave: (sale as unknown as { updatedAt?: Date }).updatedAt?.getTime() ?? null,
          statusAtSave: sale.delivery?.status ?? null,
          ...(client?.nombreCompleto === undefined ? {} : { clientName: client.nombreCompleto }),
          ...(client?.address === undefined ? {} : { address: client.address }),
          zoneName: zone.name,
          ...itemFields
        }
      }),
      warnings: fuelAvailable ? ['TIME_WINDOWS_NOT_CONSIDERED'] : ['TIME_WINDOWS_NOT_CONSIDERED', 'FUEL_UNAVAILABLE'],
      factorsConsidered: ['DISTANCE', 'DURATION', 'FUEL_CONSUMPTION'],
      algorithmVersion: config.algorithm,
      algorithmProvider: config.provider,
      routingConfigRevision: config.revision,
      ruleVersion: CANDIDATE_RULE_VERSION
    }
    routeForSchedule.stopEstimates = calculateStopEstimates(routeForSchedule, calculatedAt, timezone)
    return {
      zoneSnapshot: { code: zone.code, normalizedName: zone.normalizedName, name: zone.name },
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
    if (context.actor === undefined || context.actor === '') throw new RoutePreviewError('INVALID_ROUTE_INPUT', 'Authenticated actor is required')
    const result = await previewRoute(input, context)
    if (result.zoneSnapshot === undefined) throw new RoutePreviewError('INVALID_CONFIGURATION', 'Preview zone is missing')
    const token = randomBytes(32).toString('hex')
    const now = Date.now()
    const slotFilter = { _id: context.actor, $or: [{ claimUntil: { $exists: false } }, { claimUntil: { $lte: new Date(now) } }] }
    const update = { $set: { actor: context.actor, tokenHash: receiptHash(token), expiresAt: new Date(now + 10 * 60 * 1000), purgeAt: new Date(now + 10 * 60 * 1000 + 30000), snapshotId: new Types.ObjectId(), snapshot: buildSnapshot(input, result, result.zoneSnapshot, context.actor), input }, $unset: { claimId: 1, claimUntil: 1 } }
    try {
      await RoutePlanPreviewReceiptModel.findOneAndUpdate(slotFilter, update, { upsert: true, new: true }).lean()
    } catch (error) {
      if (!isDuplicateKey(error)) throw error
      // An initial concurrent upsert may have inserted the slot. Retry once;
      // an active claim still conflicts on the actor's unique _id.
      try {
        await RoutePlanPreviewReceiptModel.findOneAndUpdate(slotFilter, update, { upsert: true, new: true }).lean()
      } catch (retryError) {
        if (isDuplicateKey(retryError)) throw receiptConflict()
        throw retryError
      }
    }
    logRoutePlanEvent({ event: 'route_plan_preview_completed', correlationId: context.correlationId, latencyMs: Date.now() - start, provider: result.algorithmProvider, algorithmVersion: result.algorithmVersion, ruleVersion: result.ruleVersion, routingConfigRevision: result.routingConfigRevision, resultCode: 'SUCCESS' })
    return { ...result, receipt: token }
  } catch (error) {
    const mapped = previewProviderError(error)
    logRoutePlanEvent({ event: 'route_plan_preview_failed', correlationId: context.correlationId, latencyMs: Date.now() - start, ruleVersion: CANDIDATE_RULE_VERSION, resultCode: errorCode(mapped), diagnostic: providerDiagnostic(mapped) })
    throw error
  }
}

const buildSnapshot = (input: RoutePreviewRequest, result: RoutePreview, zone: { code: string, normalizedName: string, name: string }, createdBy: string): RoutePlan => {
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
      longitude: result.route.depot.longitude,
      ...(result.route.depot.address === undefined ? {} : { address: result.route.depot.address })
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
  return snapshot
}

const receiptHash = (token: string): string => createHash('sha256').update(token).digest('hex')
const receiptConflict = (): RoutePreviewError => new RoutePreviewError('PREVIEW_RECEIPT_CONFLICT', 'Preview receipt is invalid, expired, already used, or no longer fresh')
const isDuplicateKey = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === 11000

const assertReceiptFresh = async (input: RoutePreviewRequest, snapshot: RoutePlan): Promise<void> => {
  const { start, end } = serviceDateRange(input.serviceDate)
  const sales = await SaleModel.find({ _id: { $in: input.saleIds.map((id) => new Types.ObjectId(id)) } }).sort({ _id: 1 }).lean()
  if (sales.length !== input.saleIds.length) throw receiptConflict()
  const stops = new Map(snapshot.stops.map((stop) => [stop.clientId, stop]))
  for (const sale of sales) {
    const stop = stops.get(String(sale.idCliente))
    const reference = snapshot.saleReferences?.find((item) => item.saleId === String(sale._id))
    const updatedAt = (sale as unknown as { updatedAt?: Date }).updatedAt?.getTime() ?? null
    if (stop === undefined || !stop.saleIds.includes(String(sale._id)) || CANCELLED_SALE_PATTERN.test(sale.estado) || sale.delivery?.status !== 'PENDING' || sale.delivery.serviceDate === undefined || sale.delivery.serviceDate < start || sale.delivery.serviceDate >= end || reference?.versionAtSave !== updatedAt) throw receiptConflict()
  }
  const clients = await ClientModel.find({ _id: { $in: [...stops.keys()] } }).lean()
  if (clients.length !== stops.size) throw receiptConflict()
  for (const client of clients) {
    const stop = stops.get(String(client._id))
    if (stop === undefined || previewErrorForClient(client) !== undefined || String(client.deliveryZoneId) !== input.deliveryZoneId || client.lat !== stop.latitude || client.lng !== stop.longitude) throw receiptConflict()
  }
  const zone = await DeliveryZoneModel.findOne({ _id: input.deliveryZoneId, active: true }).lean()
  if (zone === null || zone.code !== snapshot.zoneSnapshot.code || zone.name !== snapshot.zoneSnapshot.name || zone.normalizedName !== snapshot.zoneSnapshot.normalizedName) throw receiptConflict()
  const config = await RoutingConfigModel.findOne({ key: 'deposito_1', enabled: true }).lean()
  if (config === null || config.revision !== snapshot.routingConfigRevision) throw receiptConflict()
  const vehicle = input.vehicleId === undefined ? null : await getVehicleById(input.vehicleId)
  if (resolveAssignedConsumption(vehicle) !== snapshot.fuelAssumptions?.consumptionLitersPer100Km || (vehicle?.code ?? null) !== snapshot.fuelAssumptions?.vehicleCode) throw receiptConflict()
}

const saveSnapshot = async (input: { receipt: string }, createdBy: string, context: RoutePlanRequestContext = {}): Promise<RoutePlan> => {
  if (typeof input.receipt !== 'string' || !/^[a-f0-9]{64}$/.test(input.receipt) || createdBy === '') throw receiptConflict()
  const now = new Date()
  const claimId = randomBytes(16).toString('hex')
  const id = createdBy
  const tokenHash = receiptHash(input.receipt)
  const receipt = await RoutePlanPreviewReceiptModel.findOneAndUpdate({ _id: id, actor: createdBy, tokenHash, expiresAt: { $gt: now }, $or: [{ claimUntil: { $exists: false } }, { claimUntil: { $lte: now } }] }, { $set: { claimId, claimUntil: new Date(now.getTime() + 30000) } }, { new: true }).lean()
  if (receipt === null) throw receiptConflict()
  try {
    if (await RoutePlanModel.findById(receipt.snapshotId).lean() !== null) throw receiptConflict()
    await assertReceiptFresh(receipt.input, receipt.snapshot)
    const checkedAt = new Date()
    const renewed = await RoutePlanPreviewReceiptModel.updateOne(
      { _id: id, actor: createdBy, tokenHash, claimId, claimUntil: { $gt: checkedAt }, expiresAt: { $gt: checkedAt } },
      { $set: { claimUntil: new Date(checkedAt.getTime() + 30000) } }
    )
    if (renewed.matchedCount !== 1) throw receiptConflict()
    const saved = await RoutePlanModel.create({ ...receipt.snapshot, _id: receipt.snapshotId })
    await RoutePlanPreviewReceiptModel.updateOne({ _id: id, tokenHash, claimId }, { $unset: { claimId: 1, claimUntil: 1 } })
    logRoutePlanEvent({ event: 'route_plan_snapshot_saved', correlationId: context.correlationId, latencyMs: Date.now() - now.getTime(), resultCode: 'SUCCESS' })
    return saved
  } catch (error) {
    await RoutePlanPreviewReceiptModel.updateOne({ _id: id, tokenHash, claimId }, { $unset: { claimId: 1, claimUntil: 1 } })
    if (isDuplicateKey(error)) throw receiptConflict()
    throw error
  }
}

// Transitional legacy saves recalculate with provider calls and cannot guarantee
// the reviewed route. They neither issue nor consume receipts, and retain the old
// non-idempotent save behavior. The shared preview endpoint has no client-version
// marker: a legacy preview can still replace the actor's unclaimed receipt.
// Retire this path after migration; rollback before then breaks legacy clients,
// while rolling back receipt support breaks newer clients.
const saveLegacySnapshot = async (input: RoutePreviewRequest, createdBy: string, context: RoutePlanRequestContext = {}): Promise<RoutePlan> => {
  if (typeof createdBy !== 'string' || createdBy === '') throw new RoutePreviewError('INVALID_ROUTE_INPUT', 'Authenticated actor is required')
  const start = Date.now()
  const calculated = await previewRoute(input, { ...context, actor: createdBy })
  if (calculated.zoneSnapshot === undefined) throw new RoutePreviewError('INVALID_CONFIGURATION', 'Preview zone is missing')
  const saved = await RoutePlanModel.create(buildSnapshot(input, calculated, calculated.zoneSnapshot, createdBy))
  logRoutePlanEvent({ event: 'route_plan_snapshot_saved', correlationId: context.correlationId, latencyMs: Date.now() - start, resultCode: 'SUCCESS' })
  return saved
}

type CurrentSaleRead = Parameters<typeof detectStaleness>[1]

const readStateFromSales = async (snapshot: RoutePlan, currentSales: CurrentSaleRead, persistProjection = true): Promise<RoutePlanReadState> => {
  if (snapshot.saleReferences === undefined || snapshot.saleReferences.length === 0) {
    return { staleness: null, readWarnings: [] }
  }

  const staleness = detectStaleness(snapshot, currentSales)
  if (persistProjection) {
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
  }
  return {
    staleness,
    readWarnings: staleness.stale ? [STALE_ROUTE_WARNING] : []
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
  return await readStateFromSales(snapshot, currentSales as unknown as CurrentSaleRead)
}

const readStatesForSnapshots = async (snapshots: RoutePlan[]): Promise<Map<string, RoutePlanReadState>> => {
  const saleIds = [...new Set(snapshots.flatMap((snapshot) => snapshot.saleReferences?.map((reference) => reference.saleId) ?? []))]
    .filter((saleId) => Types.ObjectId.isValid(saleId))
    .map((saleId) => new Types.ObjectId(saleId))
  const currentSales = saleIds.length === 0
    ? []
    : await SaleModel.find(
      { _id: { $in: saleIds } },
      { _id: 1, updatedAt: 1, estado: 1, delivery: 1 }
    ).lean()
  const currentSaleById = new Map(currentSales.map((sale) => [String(sale._id), sale]))
  const states = new Map<string, RoutePlanReadState>()
  const operations = []
  for (const snapshot of snapshots) {
    const snapshotSales = (snapshot.saleReferences ?? [])
      .map((reference) => currentSaleById.get(reference.saleId))
      .filter((sale): sale is (typeof currentSales)[number] => sale !== undefined)
    const state = await readStateFromSales(snapshot, snapshotSales as unknown as CurrentSaleRead, false)
    states.set(String(snapshot._id), state)
    if (snapshot.saleReferences !== undefined && snapshot.saleReferences.length > 0) {
      operations.push({
        updateOne: {
          filter: { snapshotId: String(snapshot._id) },
          update: {
            $set: {
              stale: state.staleness?.stale ?? false,
              staleCauses: state.staleness?.causes ?? [],
              staleDetectedAt: state.staleness?.detectedAt
            }
          }
        }
      })
    }
  }
  if (operations.length > 0) await RoutePlanOperationalModel.bulkWrite(operations)
  return states
}

const withReadState = async (snapshot: RoutePlan): Promise<RoutePlan> => ({
  ...snapshot,
  ...(await readState(snapshot))
})

interface DriverSnapshot {
  snapshot: RoutePlan & { _id: Types.ObjectId }
  projection?: RoutePlanOperational
}

// Read authorization and snapshot in the same database operation.
const getDriverSnapshots = async (driverId: string, filter: Record<string, unknown>, sort: Record<string, 1 | -1>, limit: number): Promise<DriverSnapshot[]> => {
  const matches = await RoutePlanModel.aggregate<RoutePlan & { _id: Types.ObjectId, operational: RoutePlanOperational[] }>([
    { $match: filter },
    { $lookup: { from: RoutePlanOperationalModel.collection.name, let: { snapshotId: { $toString: '$_id' } }, pipeline: [{ $match: { $expr: { $eq: ['$snapshotId', '$$snapshotId'] } } }], as: 'operational' } },
    { $match: { $expr: { $eq: [{ $cond: [{ $gt: [{ $size: '$operational' }, 0] }, { $arrayElemAt: ['$operational.assignments.driverId', 0] }, '$assignments.driverId'] }, driverId] } } },
    { $sort: sort },
    { $limit: limit }
  ])
  return matches.map(({ operational, ...snapshot }) => ({ snapshot, projection: operational[0] }))
}

const listSnapshots = async (context: RoutePlanRequestContext = {}): Promise<RoutePlan[]> => {
  const start = Date.now()
  try {
    const snapshotRead = context.driverId === undefined
      ? await RoutePlanModel.find({}).sort({ createdAt: -1, _id: -1 }).limit(MAX_SNAPSHOT_LIST_READS + 1).lean()
      : (await getDriverSnapshots(context.driverId, {}, { createdAt: -1, _id: -1 }, MAX_SNAPSHOT_LIST_READS + 1)).map((entry) => entry.snapshot)
    const truncated = snapshotRead.length > MAX_SNAPSHOT_LIST_READS
    const snapshots = truncated ? snapshotRead.slice(0, MAX_SNAPSHOT_LIST_READS) : snapshotRead
    const readStates = await readStatesForSnapshots(snapshots)
    const snapshotsWithReadState = snapshots.map((snapshot) => ({ ...snapshot, ...(readStates.get(String(snapshot._id)) ?? { staleness: null, readWarnings: [] }) }))
    if (truncated && snapshotsWithReadState.length > 0) {
      snapshotsWithReadState[0].readWarnings = [...(snapshotsWithReadState[0].readWarnings ?? []), 'SNAPSHOT_LIST_LIMIT_REACHED']
    }
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
    const snapshot = context.driverId === undefined
      ? await RoutePlanModel.findById(id).lean()
      : (await getDriverSnapshots(context.driverId, { _id: new Types.ObjectId(id) }, { _id: 1 }, 1))[0]?.snapshot ?? null
    const snapshotWithReadState = snapshot === null ? null : await withReadState(snapshot)
    logRoutePlanEvent({ event: 'route_plan_snapshot_read_completed', correlationId: context.correlationId, latencyMs: Date.now() - start, resultCode: snapshot === null ? 'ROUTE_PLAN_NOT_FOUND' : 'SUCCESS' })
    return snapshotWithReadState
  } catch (error) {
    logRoutePlanEvent({ event: 'route_plan_snapshot_read_failed', correlationId: context.correlationId, latencyMs: Date.now() - start, resultCode: 'INTERNAL_ERROR' })
    throw error
  }
}

export { CANDIDATE_RULE_VERSION, MAX_CANDIDATE_READS, MAX_SNAPSHOT_LIST_READS, getCandidates, getGlobalCandidates, getAssignmentOptions, getRoutingConfig, updateRoutingConfig, preview, saveSnapshot, saveLegacySnapshot, listSnapshots, getSnapshot, getDriverSnapshots, RoutePreviewError, logRoutePlanEvent }
