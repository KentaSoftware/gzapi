import {
  SIMULATION_CONTRACT_IDS,
  SIMULATION_DATA_QUALITY,
  SIMULATION_RECORD_STATUSES,
  SIMULATION_ROUTE_SNAPSHOT_STATUSES,
  SIMULATION_VIABILITY
} from '../../src/interfaces/simulation.interface'

const ROUTE_ID = '507f1f77bcf86cd799439011'
const CLIENT_ID = '507f1f77bcf86cd799439012'
const SALE_ID = '507f1f77bcf86cd799439013'
const PRODUCT_ID = '507f1f77bcf86cd799439014'
const USER_ID = '507f1f77bcf86cd799439015'
const BASE_HASH = 'a'.repeat(64)
const CAPTURED_AT = '2026-11-01T12:00:00.000Z'

const validVariant = {
  name: 'Optimized',
  overrides: [{ key: 'fuelPricePerLiter', value: 1200.5 }],
  directLoad: [{ productId: PRODUCT_ID, quantity: 10, projectedSalesQuantity: 8 }]
}

const validCalculation = {
  baseScenarioHash: BASE_HASH,
  variantId: 'variant-optimized',
  dataQuality: SIMULATION_DATA_QUALITY.COMPLETE,
  viability: SIMULATION_VIABILITY.VIABLE,
  recommended: true,
  risks: [],
  components: [{ code: 'fuel', amountArs: 100.25 }],
  totals: {
    revenueArs: 1000,
    merchandiseCostArs: 100,
    operatingCostArs: 50,
    marginArs: 850
  },
  calculatedAt: CAPTURED_AT
}

const validRouteSnapshot = {
  contractVersion: SIMULATION_CONTRACT_IDS.ROUTE,
  capturedAt: CAPTURED_AT,
  routeId: ROUTE_ID,
  status: SIMULATION_ROUTE_SNAPSHOT_STATUSES.VALIDATED,
  zoneCode: 'Z-01',
  stops: [{ sequence: 1, clientId: CLIENT_ID, saleIds: [SALE_ID] }],
  distanceMeters: 10000,
  durationSeconds: 3600,
  vehicle: { vehicleCode: 'V-01', fuelConsumptionLitersPer100Km: 12.5 },
  capacity: {
    maxWeight: { value: 1500, unit: 'kg' },
    maxVolume: { value: 8, unit: 'm3' }
  },
  tollsArs: 500,
  parkingArs: 0
}

const validStockSnapshot = {
  contractVersion: SIMULATION_CONTRACT_IDS.STOCK,
  capturedAt: CAPTURED_AT,
  products: [{
    productId: PRODUCT_ID,
    availableQuantity: 20,
    unitCostArs: 100.5,
    presalePriceArs: 150.75,
    weight: { value: 1, unit: 'kg' },
    volume: { value: 0.5, unit: 'l' }
  }]
}

const validConfigurationInput = {
  vehicleCode: 'V-01',
  zoneCode: 'Z-01',
  period: { from: '2026-11-01', to: '2026-11-30' },
  values: { fuelPricePerLiter: 1200.5, tollsArs: 500 },
  limits: { demandMaximum: 100 },
  reason: 'Homologated baseline',
  approval: {
    approvedBy: USER_ID,
    approvalId: 'approval-2026-11-01',
    approvedAt: CAPTURED_AT
  }
}

const validRun = {
  status: SIMULATION_RECORD_STATUSES.ACTIVE,
  createdBy: USER_ID,
  sourceRouteId: ROUTE_ID,
  routeSnapshot: validRouteSnapshot,
  stockSnapshot: validStockSnapshot,
  baseScenarioHash: BASE_HASH,
  variant: validVariant,
  calculation: validCalculation,
  versions: {
    rulesVersion: 'simulation-rules-v1',
    configurationVersion: 'config-1',
    routeContractVersion: SIMULATION_CONTRACT_IDS.ROUTE,
    stockContractVersion: SIMULATION_CONTRACT_IDS.STOCK,
    calculatedAt: CAPTURED_AT,
    correlationId: 'correlation-1'
  }
}

const validConfigVersion = {
  version: 1,
  vehicleCode: 'V-01',
  zoneCode: 'Z-01',
  period: { from: new Date('2026-11-01T00:00:00.000Z'), to: new Date('2026-11-30T00:00:00.000Z') },
  values: { fuelPricePerLiter: 1200.5 },
  limits: { demandMaximum: 100 },
  reason: 'Homologated baseline',
  createdBy: USER_ID,
  approvedBy: USER_ID,
  approvalId: 'approval-2026-11-01',
  approvedAt: new Date(CAPTURED_AT),
  status: SIMULATION_RECORD_STATUSES.ACTIVE
}

const validPresetVersion = {
  name: 'Conservative',
  version: 1,
  definition: { overrides: validVariant.overrides, directLoad: validVariant.directLoad },
  reason: 'Baseline preset',
  createdBy: USER_ID,
  status: SIMULATION_RECORD_STATUSES.ACTIVE
}

export {
  ROUTE_ID,
  CLIENT_ID,
  SALE_ID,
  PRODUCT_ID,
  USER_ID,
  BASE_HASH,
  CAPTURED_AT,
  validVariant,
  validCalculation,
  validRouteSnapshot,
  validStockSnapshot,
  validConfigurationInput,
  validRun,
  validConfigVersion,
  validPresetVersion
}
