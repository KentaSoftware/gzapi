export const ROUTING_CONFIG_KEYS = {
  DEPOSITO_1: 'deposito_1'
} as const

export type RoutingConfigKey = (typeof ROUTING_CONFIG_KEYS)[keyof typeof ROUTING_CONFIG_KEYS]

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
}

export interface RoutingConfig {
  _id?: unknown
  key: RoutingConfigKey
  enabled: boolean
  revision: number
  depot: RoutingDepot
  provider: string
  algorithm: string
  createdAt?: Date
  updatedAt?: Date
}

export interface RoutePlanZoneSnapshot {
  code: string
  normalizedName: string
  name: string
}

export interface RoutePlanStop {
  saleId: string
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
  planningDate: Date
  zoneSnapshot: RoutePlanZoneSnapshot
  selectedSaleIds: string[]
  depot: RoutingDepot
  stops: RoutePlanStop[]
  segments: RoutePlanSegment[]
  metrics: RoutePlanMetrics
  algorithm: RoutePlanAlgorithm
  routingConfigRevision: number
  warnings: string[]
  audit: RoutePlanAudit
  createdAt?: Date
}
