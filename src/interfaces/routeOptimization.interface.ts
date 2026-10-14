import type { SaleDeliveryStatus } from './sale.interface'

export const ROUTING_CONFIG_KEYS = {
  DEPOSITO_1: 'deposito_1'
} as const

export type RoutingConfigKey = (typeof ROUTING_CONFIG_KEYS)[keyof typeof ROUTING_CONFIG_KEYS]

export const ROUTE_MODES = {
  GOOGLE_ROUTES: 'google-routes'
} as const

export type RouteMode = (typeof ROUTE_MODES)[keyof typeof ROUTE_MODES]

export const ROUTE_OPERATIONAL_STATUS = {
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED'
} as const

export type RouteOperationalStatus = (typeof ROUTE_OPERATIONAL_STATUS)[keyof typeof ROUTE_OPERATIONAL_STATUS]

export const ROUTE_METRIC_AVAILABILITY = {
  CALCULATED: 'CALCULATED',
  ESTIMATED: 'ESTIMATED',
  OPERATIONAL: 'OPERATIONAL',
  UNAVAILABLE: 'UNAVAILABLE'
} as const

export type RouteMetricAvailability = (typeof ROUTE_METRIC_AVAILABILITY)[keyof typeof ROUTE_METRIC_AVAILABILITY]

export const ROUTE_SNAPSHOT_STALENESS_CAUSE = {
  MODIFIED: 'MODIFIED',
  CANCELLED: 'CANCELLED'
} as const

export type RouteSnapshotStalenessCause = (typeof ROUTE_SNAPSHOT_STALENESS_CAUSE)[keyof typeof ROUTE_SNAPSHOT_STALENESS_CAUSE]

export const DEFAULT_ROUTE_ALGORITHM = 'nearest-neighbor-2opt-v1'

export interface DeliveryZone {
  _id?: unknown
  code: string
  normalizedName: string
  name: string
  active: boolean
  createdAt?: Date
  updatedAt?: Date
}

export interface RoutingDepot {
  name: string
  latitude: number
  longitude: number
  address?: string
}

export interface RoutingConfig {
  _id?: unknown
  key: RoutingConfigKey
  enabled: boolean
  revision: number
  depot: RoutingDepot
  fuelConsumptionLitersPer100Km?: number
  maxStops?: number
  provider: string
  algorithm: string
  updatedBy?: string
  createdAt?: Date
  updatedAt?: Date
}

export interface RoutingConfigUpdateInput {
  depot: RoutingDepot
  fuelConsumptionLitersPer100Km?: number
  routeMode: RouteMode
  algorithm?: string
  maxStops?: number
  enabled?: boolean
}

export interface DeliveryZoneCreateInput {
  code: string
  name: string
  active?: boolean
}

export interface DeliveryZoneUpdateInput {
  name?: string
  active?: boolean
}

export interface DeliveryZoneListFilter {
  active?: boolean
}

export const DELIVERY_ZONE_ERROR_CODES = {
  DUPLICATE_DELIVERY_ZONE_CODE: 'DUPLICATE_DELIVERY_ZONE_CODE',
  DUPLICATE_DELIVERY_ZONE_NAME: 'DUPLICATE_DELIVERY_ZONE_NAME',
  DELIVERY_ZONE_NOT_FOUND: 'DELIVERY_ZONE_NOT_FOUND'
} as const

export type DeliveryZoneErrorCode = (typeof DELIVERY_ZONE_ERROR_CODES)[keyof typeof DELIVERY_ZONE_ERROR_CODES]

export interface RoutePlanZoneSnapshot {
  code: string
  normalizedName: string
  name: string
}

export interface RoutePlanStop {
  clientId: string
  saleIds: string[]
  sequence: number
  latitude: number
  longitude: number
}

export interface RoutePlanSegment {
  fromStopSequence: number
  toStopSequence: number
  distanceMeters: number
  durationSeconds: number
}

export interface RoutePlanMetrics {
  distanceMeters: number
  durationSeconds: number
  stopCount: number
  fuelLiters?: number
  availability?: RouteMetricAvailability
}

export interface RouteFuelAssumptions {
  availability: RouteMetricAvailability
  consumptionLitersPer100Km: number | null
  distanceKm: number
  vehicleCode: string | null
  source: string
  calculatedAt: Date
}

export interface RouteScheduleAssumptions {
  calculatedAt: Date
  timezone: string
  source: string
}

export interface RouteStopEstimate {
  sequence: number
  arrival: Date | null
  cumulativeDurationSeconds: number | null
  calculatedAt: Date
  timezone: string
  availability: RouteMetricAvailability
}

export interface RouteStateDerivationInput {
  selectedSaleIds: string[]
  deliveries: SaleDeliveryStatus[]
}

export interface RouteOperationalAssignment {
  driverId?: string
  vehicleId?: string
}

export interface RouteOperationalHistoryEntry {
  status: RouteOperationalStatus
  driverId?: string
  vehicleId?: string
  changedBy: string
  changedAt: Date
  version: number
}

export interface RoutePlanOperational {
  snapshotId: string
  status: RouteOperationalStatus
  sourceDeliveryVersion: number
  assignments: RouteOperationalAssignment
  history: RouteOperationalHistoryEntry[]
  version: number
  updatedBy?: string
  updatedAt?: Date
  stale?: boolean
  staleCauses?: RouteSnapshotStalenessCause[]
  staleDetectedAt?: Date
}

export interface SelectableVehicle {
  id: string
  code: string
  fuelConsumptionLitersPer100Km: number
  attributes: Record<string, string>
  availability: boolean
}

export interface SelectableDriver {
  id: string
  nickname: string
  isActive: boolean
}

export interface RouteAssignmentOptions {
  drivers: SelectableDriver[]
  vehicles: SelectableVehicle[]
}

export interface RouteSnapshotSaleReference {
  saleId: string
  versionAtSave: number | null
  statusAtSave: SaleDeliveryStatus | null
}

export interface RouteSnapshotSaleRef {
  saleId: string
  versionAtSave: number | null
  currentVersion: number | null
  currentStatus: SaleDeliveryStatus | null
}

export interface RouteSnapshotStaleness {
  snapshotId: string
  stale: boolean
  causes: RouteSnapshotStalenessCause[]
  saleRefs: RouteSnapshotSaleRef[]
  detectedAt: Date
}

export interface RoutePlanReadState {
  staleness: RouteSnapshotStaleness | null
  readWarnings: string[]
}

export interface RoutePlanAlgorithm {
  name: string
  version: string
  provider: string
}

export interface RoutePlanAudit {
  createdBy: string
  createdAt: Date
}

export interface RoutePlan {
  _id?: unknown
  snapshotVersion: number
  planningDate: Date
  zoneSnapshot: RoutePlanZoneSnapshot
  selectedSaleIds: string[]
  depot: RoutingDepot
  stops: RoutePlanStop[]
  segments: RoutePlanSegment[]
  metrics: RoutePlanMetrics
  algorithm: RoutePlanAlgorithm
  routingConfigRevision: number
  ruleVersion: string
  encodedPolyline: string
  warnings: string[]
  audit: RoutePlanAudit
  assignments?: Required<RouteOperationalAssignment>
  fuelAssumptions?: RouteFuelAssumptions
  scheduleAssumptions?: RouteScheduleAssumptions
  stopEstimates?: RouteStopEstimate[]
  saleReferences?: RouteSnapshotSaleReference[]
  createdAt?: Date
  staleness?: RouteSnapshotStaleness | null
  readWarnings?: string[]
}

export const CANDIDATE_BLOCK_REASONS = {
  INVALID_CLIENT_REFERENCE: 'INVALID_CLIENT_REFERENCE',
  CLIENT_INACTIVE: 'CLIENT_INACTIVE',
  CLIENT_ZONE_MISMATCH: 'CLIENT_ZONE_MISMATCH',
  CLIENT_LOCATION_MISSING: 'CLIENT_LOCATION_MISSING',
  CLIENT_LOCATION_UNCONFIRMED: 'CLIENT_LOCATION_UNCONFIRMED'
} as const

export type CandidateBlockReason = (typeof CANDIDATE_BLOCK_REASONS)[keyof typeof CANDIDATE_BLOCK_REASONS]

export interface CandidateQuery {
  serviceDate: string
  deliveryZoneId: string
}

export interface CandidateEntry {
  saleId: string
  clientId?: string
  displayName?: string
  addressSummary?: string
  latitude?: number
  longitude?: number
  distanceMeters?: number
}

export interface BlockedCandidateEntry extends CandidateEntry {
  reasons: CandidateBlockReason[]
}

export interface CandidateResult {
  eligible: CandidateEntry[]
  blocked: BlockedCandidateEntry[]
  ruleVersion: string
}

export interface RouteDashboardGlobalQuery {
  status?: RouteOperationalStatus
}

export interface RouteDashboardScopedQuery {
  serviceDate: string
  zoneCode: string
  status?: RouteOperationalStatus
}

export type RouteDashboardQuery = RouteDashboardGlobalQuery | RouteDashboardScopedQuery

export interface RouteDashboardKpis {
  activeRoutes: number
  pendingOrders: number
  totalDistanceMeters: number | null
  estimatedFuelLiters: number | null
}

export interface RouteDashboardStop {
  clientId: string
  saleIds: string[]
  sequence: number
  latitude: number
  longitude: number
}

export interface RouteDashboardSegment {
  fromStopSequence: number
  toStopSequence: number
  distanceMeters: number
  durationSeconds: number
}

export interface RouteDashboardCard {
  id: string
  status: RouteOperationalStatus
  zoneCode: string
  selectedSaleIds: string[]
  clientCount: number
  metrics: {
    distanceMeters: number
    durationSeconds: number
    fuelLiters: number | null
  }
  assignments: RouteOperationalAssignment
  warnings: string[]
  stale: boolean
  depot?: RoutingDepot
  encodedPolyline?: string
  stops?: RouteDashboardStop[]
  segments?: RouteDashboardSegment[]
  metricAvailability?: RouteMetricAvailability
  fuelAssumptions?: RouteFuelAssumptions
  scheduleAssumptions?: RouteScheduleAssumptions
  stopEstimates?: RouteStopEstimate[]
  saleReferences?: RouteSnapshotSaleReference[]
  staleCauses?: RouteSnapshotStalenessCause[]
}

export const ROUTE_MAP_LOCATION_STATUS = {
  ORDER: 'ORDER',
  NO_ORDER: 'NO_ORDER',
  EXCLUDED: 'EXCLUDED'
} as const

export type RouteMapLocationStatus = (typeof ROUTE_MAP_LOCATION_STATUS)[keyof typeof ROUTE_MAP_LOCATION_STATUS]

export interface RouteMapLocation {
  clientId: string
  displayName: string
  addressSummary?: string
  latitude: number
  longitude: number
  status: RouteMapLocationStatus
}

export interface RouteDashboard {
  filters: RouteDashboardQuery
  kpis: RouteDashboardKpis
  routes: RouteDashboardCard[]
  candidates: CandidateResult
  warnings: string[]
  mapLocations: RouteMapLocation[]
}

export interface RouteLocation {
  id: string
  name: string
  latitude: number
  longitude: number
}

export interface RouteStop {
  clientId: string
  saleIds: string[]
  latitude: number
  longitude: number
}

export interface RouteMatrixSegment {
  fromId: string
  toId: string
  distanceMeters: number
  durationSeconds: number
}

export interface RouteHeuristicInput {
  depot: RouteLocation
  stops: RouteStop[]
  matrix: RouteMatrixSegment[]
}

export interface RouteHeuristicResult {
  orderedStops: RouteStop[]
  segments: RouteMatrixSegment[]
  distanceMeters: number
  durationSeconds: number
}

export interface RouteMatrixRequest {
  origins: RouteLocation[]
  destinations: RouteLocation[]
}

export interface RouteMatrix {
  segments: RouteMatrixSegment[]
}

export interface FinalRouteRequest {
  origin: RouteLocation
  intermediates: RouteLocation[]
  destination: RouteLocation
}

export interface FinalRoute {
  encodedPolyline: string
  distanceMeters: number
  durationSeconds: number
}

export interface RoutePreviewRequest extends CandidateQuery {
  saleIds: string[]
  driverId?: string
  vehicleId?: string
}

export interface RoutePreview {
  route: {
    depot: RoutePreviewDepot
    stops: RouteStop[]
    segments: RouteMatrixSegment[]
    encodedPolyline: string
  }
  metrics: {
    distanceMeters: number
    durationSeconds: number
    stopCount: number
    fuelLiters: number | null
    availability?: RouteMetricAvailability
  }
  assignments: Required<RouteOperationalAssignment>
  fuelAssumptions: RouteFuelAssumptions
  scheduleAssumptions: RouteScheduleAssumptions
  stopEstimates: RouteStopEstimate[]
  saleReferences: RouteSnapshotSaleReference[]
  warnings: string[]
  factorsConsidered: string[]
  algorithmVersion: string
  algorithmProvider: string
  routingConfigRevision: number
  ruleVersion: string
}

export interface RoutePreviewDepot extends RouteLocation {
  address?: string
}
