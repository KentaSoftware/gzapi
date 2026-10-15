import { expect } from 'chai'
import {
  ROUTE_METRIC_AVAILABILITY,
  ROUTE_OPERATIONAL_STATUS
} from '../../src/interfaces/routeOptimization.interface'
import {
  routeFuelAssumptionsSchema,
  routeMetricAvailabilitySchema,
  routeOperationalStatusSchema,
  routePlanOperationalSchema,
  routePlanSnapshotSchema,
  routingDepotSchema,
  routeScheduleAssumptionsSchema,
  routeSnapshotStalenessSchema,
  routeStopEstimateSchema,
  selectableVehicleSchema
} from '../../src/schemas/routeOptimization'
import { routePlanOperationalSchema as routePlanOperationalMongooseSchema } from '../../src/models/routePlanOperational'
import { runRouteDepotAddressBackfill } from '../../migrations/route-plan-003-backfill-depot-address'

describe('Route dashboard contracts', () => {
  it('accepts optional depot addresses while retaining legacy depot payloads', () => {
    const legacyDepot = { name: 'Legacy depot', latitude: -27, longitude: -65 }
    const addressedDepot = { ...legacyDepot, address: 'Depósito de prueba, San Miguel de Tucumán, Tucumán' }

    expect(routingDepotSchema.safeParse(legacyDepot).success).to.equal(true)
    expect(routingDepotSchema.safeParse(addressedDepot).success).to.equal(true)
  })

  it('backfills only missing routing-config depot addresses and is idempotent', async () => {
    const updates: Array<{ filter: Record<string, unknown>, update: Record<string, unknown> }> = []
    const database = {
      getCollection: (name: string) => {
        expect(name).to.equal('routingconfigs')
        return {
          updateMany: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
            updates.push({ filter, update })
          }
        }
      }
    }

    await runRouteDepotAddressBackfill(database)
    await runRouteDepotAddressBackfill(database)

    expect(updates).to.have.length(2)
    expect(updates[0]).to.deep.equal({
      filter: { key: 'deposito_1', 'depot.address': { $exists: false } },
      update: { $set: { 'depot.address': 'Depósito de prueba, San Miguel de Tucumán, Tucumán' } }
    })
  })

  it('S-21: exposes the approved operational statuses and metric availability values', () => {
    expect(ROUTE_OPERATIONAL_STATUS).to.deep.equal({
      PENDING: 'PENDING',
      IN_PROGRESS: 'IN_PROGRESS',
      COMPLETED: 'COMPLETED'
    })
    expect(ROUTE_METRIC_AVAILABILITY).to.deep.equal({
      CALCULATED: 'CALCULATED',
      ESTIMATED: 'ESTIMATED',
      OPERATIONAL: 'OPERATIONAL',
      UNAVAILABLE: 'UNAVAILABLE'
    })
    expect(routeOperationalStatusSchema.safeParse('IN_PROGRESS').success).to.equal(true)
    expect(routeMetricAvailabilitySchema.safeParse('UNKNOWN').success).to.equal(false)
  })

  it('TC-018: accepts unavailable fuel assumptions without fabricating consumption', () => {
    const assumptions = {
      availability: 'UNAVAILABLE',
      consumptionLitersPer100Km: null,
      distanceKm: 42.5,
      vehicleCode: null,
      source: 'assigned-vehicle',
      calculatedAt: new Date('2026-10-12T10:00:00.000Z')
    }

    expect(routeFuelAssumptionsSchema.safeParse(assumptions).success).to.equal(true)
    expect(JSON.stringify(assumptions)).to.not.contain('price')
    expect(JSON.stringify(assumptions)).to.not.contain('currency')
  })

  it('TC-023: validates frozen schedule assumptions and nullable stop estimates', () => {
    const assumptions = {
      calculatedAt: new Date('2026-10-12T10:00:00.000Z'),
      timezone: 'America/Argentina/Buenos_Aires',
      source: 'system-clock'
    }
    const estimate = {
      sequence: 1,
      arrival: null,
      cumulativeDurationSeconds: null,
      calculatedAt: assumptions.calculatedAt,
      timezone: assumptions.timezone,
      availability: 'UNAVAILABLE'
    }

    expect(routeScheduleAssumptionsSchema.safeParse(assumptions).success).to.equal(true)
    expect(routeStopEstimateSchema.safeParse(estimate).success).to.equal(true)
  })

  it('NFR-004: validates operational assignments and snapshot staleness references', () => {
    const projection = {
      snapshotId: 'snapshot-1',
      status: 'PENDING',
      sourceDeliveryVersion: 3,
      assignments: { driverId: 'driver-1', vehicleId: 'vehicle-1' },
      history: [],
      version: 1
    }
    const staleness = {
      snapshotId: 'snapshot-1',
      stale: true,
      causes: ['MODIFIED'],
      saleRefs: [{ saleId: 'sale-1', versionAtSave: 1, currentVersion: 2, currentStatus: 'PENDING' }],
      detectedAt: new Date('2026-10-12T10:00:00.000Z')
    }
    const vehicle = {
      id: 'vehicle-1',
      code: 'AA123AA',
      fuelConsumptionLitersPer100Km: 12.5,
      attributes: {},
      availability: true
    }

    expect(routePlanOperationalSchema.safeParse(projection).success).to.equal(true)
    expect(routeSnapshotStalenessSchema.safeParse(staleness).success).to.equal(true)
    expect(selectableVehicleSchema.safeParse(vehicle).success).to.equal(true)
  })

  it('NFR-004: keeps the operational projection separate from immutable snapshots', () => {
    expect(routePlanOperationalMongooseSchema.path('snapshotId').options.immutable).to.equal(true)
    expect(routePlanOperationalMongooseSchema.path('assignments.driverId')).to.not.equal(undefined)
    expect(routePlanOperationalMongooseSchema.path('assignments.vehicleId')).to.not.equal(undefined)
    expect(routePlanOperationalMongooseSchema.path('history')).to.not.equal(undefined)
    expect(routePlanOperationalMongooseSchema.path('stale')).to.not.equal(undefined)
    expect(routePlanOperationalMongooseSchema.path('staleCauses')).to.not.equal(undefined)
    expect(routePlanOperationalMongooseSchema.path('staleDetectedAt')).to.not.equal(undefined)
  })

  it('keeps new snapshot dashboard fields optional for legacy reads', () => {
    const legacySnapshot = {
      snapshotVersion: 1,
      planningDate: new Date('2026-10-12T00:00:00.000Z'),
      zoneSnapshot: { code: 'NORTE', normalizedName: 'norte', name: 'Norte' },
      selectedSaleIds: ['sale-1'],
      depot: { name: 'Depot', latitude: -34.6, longitude: -58.4 },
      stops: [{ clientId: 'client-1', saleIds: ['sale-1'], sequence: 1, latitude: -34.61, longitude: -58.41 }],
      segments: [],
      metrics: { distanceMeters: 0, durationSeconds: 0, stopCount: 1 },
      algorithm: { name: 'heuristic', version: '1', provider: 'internal' },
      routingConfigRevision: 1,
      ruleVersion: 'candidate-eligibility-v1',
      encodedPolyline: '',
      warnings: [],
      audit: { createdBy: 'user-1', createdAt: new Date('2026-10-12T10:00:00.000Z') }
    }

    expect(routePlanSnapshotSchema.safeParse(legacySnapshot).success).to.equal(true)
  })
})
