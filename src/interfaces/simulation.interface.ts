import type { Types } from 'mongoose'

export const SIMULATION_RECORD_STATUSES = {
  ACTIVE: 'ACTIVE',
  ARCHIVED: 'ARCHIVED'
} as const

export type SimulationRecordStatus = (typeof SIMULATION_RECORD_STATUSES)[keyof typeof SIMULATION_RECORD_STATUSES]

export const SIMULATION_DATA_QUALITY = {
  COMPLETE: 'COMPLETE',
  INCOMPLETE: 'INCOMPLETE'
} as const

export type SimulationDataQuality = (typeof SIMULATION_DATA_QUALITY)[keyof typeof SIMULATION_DATA_QUALITY]

export const SIMULATION_VIABILITY = {
  VIABLE: 'VIABLE',
  NOT_VIABLE: 'NOT_VIABLE',
  INCOMPLETE: 'INCOMPLETE'
} as const

export type SimulationViability = (typeof SIMULATION_VIABILITY)[keyof typeof SIMULATION_VIABILITY]

export const SIMULATION_RISK_CODES = {
  INCOMPLETE_DATA: 'INCOMPLETE_DATA',
  CAPACITY_EXCEEDED_WEIGHT: 'CAPACITY_EXCEEDED_WEIGHT',
  CAPACITY_EXCEEDED_VOLUME: 'CAPACITY_EXCEEDED_VOLUME',
  NEGATIVE_MARGIN: 'NEGATIVE_MARGIN'
} as const

export type SimulationRiskCode = (typeof SIMULATION_RISK_CODES)[keyof typeof SIMULATION_RISK_CODES]

export const SIMULATION_ROUTE_SNAPSHOT_STATUSES = {
  VALIDATED: 'VALIDATED',
  DRAFT: 'DRAFT',
  CANCELLED: 'CANCELLED'
} as const

export type SimulationRouteSnapshotStatus = (typeof SIMULATION_ROUTE_SNAPSHOT_STATUSES)[keyof typeof SIMULATION_ROUTE_SNAPSHOT_STATUSES]

export const SIMULATION_CONTRACT_IDS = {
  ROUTE: 'SIM-ROUTE-SNAPSHOT-001',
  STOCK: 'SIM-STOCK-SNAPSHOT-001'
} as const

export type SimulationContractId = (typeof SIMULATION_CONTRACT_IDS)[keyof typeof SIMULATION_CONTRACT_IDS]

export const SIMULATION_ERROR_CODES = {
  DISABLED: 'SIMULATION_DISABLED',
  CONTRACT_NOT_APPROVED: 'SIMULATION_CONTRACT_NOT_APPROVED',
  CONTRACT_INCOMPATIBLE: 'SIMULATION_CONTRACT_INCOMPATIBLE',
  SNAPSHOT_INCOMPLETE: 'SIMULATION_SNAPSHOT_INCOMPLETE',
  BASE_SCENARIO_INVALID: 'SIMULATION_BASE_SCENARIO_INVALID',
  TOKEN_INVALID: 'SIMULATION_TOKEN_INVALID',
  TOKEN_EXPIRED: 'SIMULATION_TOKEN_EXPIRED',
  INPUT_INVALID: 'SIMULATION_INPUT_INVALID',
  RUN_NOT_FOUND: 'SIMULATION_RUN_NOT_FOUND',
  RUN_TRANSITION_INVALID: 'SIMULATION_RUN_TRANSITION_INVALID',
  EVIDENCE_IMMUTABLE: 'SIMULATION_EVIDENCE_IMMUTABLE',
  CONFIGURATION_UNAVAILABLE: 'SIMULATION_CONFIGURATION_UNAVAILABLE',
  PRODUCER_UNAVAILABLE: 'SIMULATION_PRODUCER_UNAVAILABLE',
  REPOSITORY_ERROR: 'SIMULATION_REPOSITORY_ERROR'
} as const

export type SimulationErrorCode = (typeof SIMULATION_ERROR_CODES)[keyof typeof SIMULATION_ERROR_CODES]

export interface SimulationMeasure {
  value: number
  unit: string
}

export interface SimulationRouteStop {
  sequence: number
  clientId: string
  saleIds: string[]
}

export interface SimulationRouteVehicle {
  vehicleCode: string
  fuelConsumptionLitersPer100Km: number
}

export interface SimulationRouteCapacity {
  maxWeight: SimulationMeasure
  maxVolume: SimulationMeasure
}

export interface SimulationRouteSnapshot {
  contractVersion: string
  capturedAt: string
  routeId: string
  status: SimulationRouteSnapshotStatus
  zoneCode: string
  stops: SimulationRouteStop[]
  distanceMeters: number
  durationSeconds: number
  vehicle: SimulationRouteVehicle
  capacity: SimulationRouteCapacity
  tollsArs: number
  parkingArs: number
}

export interface SimulationStockProductSnapshot {
  productId: string
  availableQuantity: number
  unitCostArs: number
  presalePriceArs: number
  weight: SimulationMeasure
  volume: SimulationMeasure
}

export interface SimulationStockSnapshot {
  contractVersion: string
  capturedAt: string
  products: SimulationStockProductSnapshot[]
}

export interface SimulationOverride {
  key: string
  value: number
}

export interface SimulationDirectLoadLine {
  productId: string
  quantity: number
  projectedSalesQuantity: number
}

export interface SimulationVariantInput {
  name: string
  presetVersionId?: string
  overrides: SimulationOverride[]
  directLoad: SimulationDirectLoadLine[]
}

export interface SimulationCalculationComponent {
  code: string
  amountArs: number
}

export interface SimulationCalculationTotals {
  revenueArs: number
  merchandiseCostArs: number
  operatingCostArs: number
  marginArs: number
}

export interface SimulationCalculationResult {
  baseScenarioHash: string
  variantId: string
  dataQuality: SimulationDataQuality
  viability: SimulationViability
  recommended: boolean
  risks: SimulationRiskCode[]
  components: SimulationCalculationComponent[]
  totals: SimulationCalculationTotals
  calculatedAt: string
}

export interface SimulationComparisonInput {
  token: string
  variants: SimulationCalculationResult[]
}

export interface SimulationComparisonResult {
  baseScenarioHash: string
  variants: SimulationCalculationResult[]
  recommendedVariantId: string | null
}

export interface SimulationBaseScenarioInput {
  routeId: string
}

export interface SimulationSaveRunInput {
  token: string
  variant: SimulationVariantInput
}

export interface SimulationVersionEvidence {
  rulesVersion: string
  configurationVersion: string
  configurationVersionId?: Types.ObjectId
  presetVersion?: string
  routeContractVersion: string
  stockContractVersion: string
  calculatedAt: Date
  correlationId?: string
}

export interface SimulationRun {
  status: SimulationRecordStatus
  createdBy: Types.ObjectId
  archivedAt?: Date
  archivedBy?: Types.ObjectId
  sourceRouteId: string
  routeSnapshot: SimulationRouteSnapshot
  stockSnapshot: SimulationStockSnapshot
  baseScenarioHash: string
  variant: SimulationVariantInput
  calculation: SimulationCalculationResult
  versions: SimulationVersionEvidence
  recalculatedFromRunId?: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

export interface SimulationPeriod {
  from: Date
  to: Date
}

export interface SimulationConfigurationApproval {
  approvedBy: Types.ObjectId
  approvalId: string
  approvedAt: Date
}

export interface SimulationConfigVersion {
  version: number
  vehicleCode: string
  zoneCode: string
  period: SimulationPeriod
  values: Record<string, number>
  limits: Record<string, number>
  reason: string
  createdBy: Types.ObjectId
  approvedBy: Types.ObjectId
  approvalId: string
  approvedAt: Date
  status: SimulationRecordStatus
  archivedAt?: Date
  archivedBy?: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

export interface SimulationVersionedConfigurationInput {
  vehicleCode: string
  zoneCode: string
  period: {
    from: string
    to: string
  }
  values: Record<string, number>
  limits: Record<string, number>
  reason: string
  approval: {
    approvedBy: string
    approvalId: string
    approvedAt: string
  }
}

export interface SimulationPresetDefinition {
  overrides: SimulationOverride[]
  directLoad: SimulationDirectLoadLine[]
}

export interface SimulationPresetVersion {
  name: string
  version: number
  definition: SimulationPresetDefinition
  reason: string
  createdBy: Types.ObjectId
  status: SimulationRecordStatus
  archivedAt?: Date
  archivedBy?: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

export interface SimulationVersionedPresetInput {
  name: string
  definition: SimulationPresetDefinition
  reason: string
}

export interface SimulationErrorEnvelope {
  code: SimulationErrorCode
  message: string
  correlationId?: string
}
