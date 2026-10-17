import { expect } from 'chai'

import { routePlanSnapshotSchema } from '../../src/schemas/routeOptimization'

describe('Route snapshot dashboard fields', () => {
  it('S-28: accepts frozen schedule assumptions and stop estimates', () => {
    const calculatedAt = new Date('2026-10-12T10:00:00.000Z')
    const result = routePlanSnapshotSchema.safeParse({
      planningDate: calculatedAt,
      zoneSnapshot: { code: 'NORTE', normalizedName: 'norte', name: 'Norte' },
      selectedSaleIds: ['sale-1'],
      depot: { name: 'Depot', latitude: 0, longitude: 0 },
      stops: [{ clientId: 'client-1', saleIds: ['sale-1'], sequence: 1, latitude: 1, longitude: 1 }],
      segments: [],
      metrics: { distanceMeters: 1000, durationSeconds: 60, stopCount: 1, fuelLiters: null, availability: 'UNAVAILABLE' },
      algorithm: { name: 'test', version: 'test', provider: 'test' },
      routingConfigRevision: 1,
      warnings: ['FUEL_UNAVAILABLE'],
      audit: { createdBy: 'user-1', createdAt: calculatedAt },
      fuelAssumptions: {
        availability: 'UNAVAILABLE',
        consumptionLitersPer100Km: null,
        distanceKm: 1,
        vehicleCode: null,
        source: 'assigned-vehicle',
        calculatedAt
      },
      scheduleAssumptions: { calculatedAt, timezone: 'UTC', source: 'system-clock' },
      stopEstimates: [{ sequence: 1, arrival: null, cumulativeDurationSeconds: null, calculatedAt, timezone: 'UTC', availability: 'UNAVAILABLE' }],
      saleReferences: [{ saleId: 'sale-1', versionAtSave: null, statusAtSave: null }]
    })

    expect(result.success).to.equal(true)
  })

  it('accepts enriched sale references while keeping enrichment optional', () => {
    const result = routePlanSnapshotSchema.safeParse({
      planningDate: new Date('2026-10-12T00:00:00.000Z'),
      zoneSnapshot: { code: 'NORTE', normalizedName: 'norte', name: 'Norte' },
      selectedSaleIds: ['sale-1'],
      depot: { name: 'Depot', latitude: 0, longitude: 0 },
      stops: [{ clientId: 'client-1', saleIds: ['sale-1'], sequence: 1, latitude: 1, longitude: 1 }],
      segments: [],
      metrics: { distanceMeters: 0, durationSeconds: 0, stopCount: 1 },
      algorithm: { name: 'test', version: 'test', provider: 'test' },
      routingConfigRevision: 1,
      warnings: [],
      audit: { createdBy: 'user-1', createdAt: new Date('2026-10-12T00:00:00.000Z') },
      saleReferences: [{
        saleId: 'sale-1',
        versionAtSave: null,
        statusAtSave: 'PENDING',
        clientName: 'Cliente Uno',
        address: 'Calle 1',
        zoneName: 'Norte',
        itemCount: 2,
        productCount: 1,
        unitCount: 3
      }]
    })

    expect(result.success).to.equal(true)
  })
})
