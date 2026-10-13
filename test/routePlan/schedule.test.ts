import { expect } from 'chai'
import { calculateStopEstimates } from '../../src/services/routeSchedule'
import type { RoutePreview } from '../../src/interfaces/routeOptimization.interface'

describe('Route schedule estimates', () => {
  it('S-28: adds cumulative segment durations to the frozen calculation time', () => {
    const calculatedAt = new Date('2026-10-12T10:00:00.000Z')
    const route: RoutePreview = {
      route: {
        depot: { id: 'depot', name: 'Depot', latitude: -34.6, longitude: -58.4 },
        stops: [
          { clientId: 'client-1', saleIds: ['sale-1'], latitude: -34.61, longitude: -58.41, sequence: 1 },
          { clientId: 'client-2', saleIds: ['sale-2'], latitude: -34.62, longitude: -58.42, sequence: 2 }
        ],
        segments: [
          { fromId: 'depot', toId: 'client-1', distanceMeters: 1000, durationSeconds: 600 },
          { fromId: 'client-1', toId: 'client-2', distanceMeters: 2000, durationSeconds: 900 },
          { fromId: 'client-2', toId: 'depot', distanceMeters: 3000, durationSeconds: 1200 }
        ],
        encodedPolyline: 'polyline'
      },
      metrics: { distanceMeters: 6000, durationSeconds: 2700, stopCount: 2, fuelLiters: 1 },
      warnings: [],
      factorsConsidered: [],
      algorithmVersion: 'test',
      algorithmProvider: 'test',
      routingConfigRevision: 1,
      ruleVersion: 'test'
    }

    const estimates = calculateStopEstimates(route, calculatedAt, 'America/Argentina/Buenos_Aires')

    expect(estimates.map((estimate) => estimate.arrival?.toISOString())).to.deep.equal([
      '2026-10-12T10:10:00.000Z',
      '2026-10-12T10:25:00.000Z'
    ])
    expect(estimates.map((estimate) => estimate.cumulativeDurationSeconds)).to.deep.equal([600, 1500])
    expect(estimates.every((estimate) => estimate.timezone === 'America/Argentina/Buenos_Aires')).to.equal(true)
  })

  it('TC-023: does not add per-stop service time and preserves the frozen timestamp', () => {
    const calculatedAt = new Date('2026-10-12T10:00:00.000Z')
    const route = {
      route: {
        depot: { id: 'depot', name: 'Depot', latitude: 0, longitude: 0 },
        stops: [{ clientId: 'client-1', saleIds: ['sale-1'], latitude: 1, longitude: 1, sequence: 1 }],
        segments: [{ fromId: 'depot', toId: 'client-1', distanceMeters: 1, durationSeconds: 60 }],
        encodedPolyline: ''
      },
      metrics: { distanceMeters: 1, durationSeconds: 60, stopCount: 1, fuelLiters: 0 },
      warnings: [],
      factorsConsidered: [],
      algorithmVersion: 'test',
      algorithmProvider: 'test',
      routingConfigRevision: 1,
      ruleVersion: 'test'
    } satisfies RoutePreview

    const estimate = calculateStopEstimates(route, calculatedAt, 'UTC')[0]

    expect(estimate.arrival?.getTime()).to.equal(calculatedAt.getTime() + 60_000)
    expect(estimate.calculatedAt).to.not.equal(calculatedAt)
    expect(estimate.calculatedAt.toISOString()).to.equal(calculatedAt.toISOString())
  })

  it('S-26: rejects invalid calculation dates and timezones', () => {
    const route = {
      route: {
        depot: { id: 'depot', name: 'Depot', latitude: 0, longitude: 0 },
        stops: [],
        segments: [],
        encodedPolyline: ''
      },
      metrics: { distanceMeters: 0, durationSeconds: 0, stopCount: 0, fuelLiters: 0 },
      warnings: [],
      factorsConsidered: [],
      algorithmVersion: 'test',
      algorithmProvider: 'test',
      routingConfigRevision: 1,
      ruleVersion: 'test'
    } satisfies RoutePreview

    expect(() => calculateStopEstimates(route, new Date('invalid'), 'UTC')).to.throw()
    expect(() => calculateStopEstimates(route, new Date(), '')).to.throw()
  })
})
