import { expect } from 'chai'

import type { RoutePlan } from '../../src/interfaces/routeOptimization.interface'
import { detectStaleness } from '../../src/services/routeStaleness'

const snapshotFixture = (): RoutePlan => ({
  snapshotVersion: 1,
  planningDate: new Date('2026-10-12T00:00:00.000Z'),
  zoneSnapshot: { code: 'zone-1', normalizedName: 'zone-1', name: 'Zone 1' },
  selectedSaleIds: ['sale-1', 'sale-2'],
  depot: { name: 'Depot', latitude: -34.6, longitude: -58.4 },
  stops: [],
  segments: [],
  metrics: { distanceMeters: 0, durationSeconds: 0, stopCount: 0, fuelLiters: 0 },
  algorithm: { name: 'test', version: '1', provider: 'test' },
  routingConfigRevision: 1,
  ruleVersion: 'test',
  encodedPolyline: '',
  warnings: [],
  audit: { createdBy: 'test', createdAt: new Date('2026-10-12T10:00:00.000Z') },
  saleReferences: [
    { saleId: 'sale-1', versionAtSave: new Date('2026-10-12T09:00:00.000Z').getTime(), statusAtSave: 'PENDING' },
    { saleId: 'sale-2', versionAtSave: 2000, statusAtSave: 'PENDING' }
  ]
})

describe('Route snapshot staleness', () => {
  it('S-29: marks a sale modified when its version or delivery status changes', () => {
    const snapshot = snapshotFixture()
    const result = detectStaleness(snapshot, [
      { saleId: 'sale-1', updatedAt: new Date('2026-10-12T10:00:00.000Z'), delivery: { status: 'PENDING' } },
      { saleId: 'sale-2', updatedAt: new Date(3000), delivery: { status: 'DELIVERED' } }
    ])

    expect(result.stale).to.equal(true)
    expect(result.causes).to.deep.equal(['MODIFIED'])
    expect(result.saleRefs).to.deep.include.members([
      { saleId: 'sale-1', versionAtSave: new Date('2026-10-12T09:00:00.000Z').getTime(), currentVersion: new Date('2026-10-12T10:00:00.000Z').getTime(), currentStatus: 'PENDING' },
      { saleId: 'sale-2', versionAtSave: 2000, currentVersion: 3000, currentStatus: 'DELIVERED' }
    ])
  })

  it('S-29: marks an explicitly cancelled or missing sale as cancelled', () => {
    const snapshot = snapshotFixture()
    const result = detectStaleness(snapshot, [
      { saleId: 'sale-1', updatedAt: new Date('2026-10-12T09:00:00.000Z'), estado: 'CANCELLED', delivery: { status: 'PENDING' } }
    ])

    expect(result.stale).to.equal(true)
    expect(result.causes).to.deep.equal(['CANCELLED'])
    expect(result.saleRefs).to.deep.equal([
      { saleId: 'sale-1', versionAtSave: new Date('2026-10-12T09:00:00.000Z').getTime(), currentVersion: new Date('2026-10-12T09:00:00.000Z').getTime(), currentStatus: 'PENDING' },
      { saleId: 'sale-2', versionAtSave: 2000, currentVersion: null, currentStatus: null }
    ])
  })

  it('S-29: leaves unchanged historical snapshot bytes intact and requires a new route for stale data', () => {
    const snapshot = snapshotFixture()
    const bytesBefore = JSON.stringify(snapshot)
    const result = detectStaleness(snapshot, [
      { saleId: 'sale-1', updatedAt: new Date('2026-10-12T09:00:00.000Z'), delivery: { status: 'PENDING' } },
      { saleId: 'sale-2', updatedAt: new Date(2000), delivery: { status: 'PENDING' } }
    ])

    expect(result.stale).to.equal(false)
    expect(result.causes).to.deep.equal([])
    expect(JSON.stringify(snapshot)).to.equal(bytesBefore)
    expect(result.saleRefs).to.have.length(2)
  })

  it('FR-048: preserves legacy snapshots as readable without fabricating staleness evidence', () => {
    const snapshot = snapshotFixture()
    delete snapshot.saleReferences

    const result = detectStaleness(snapshot, [])

    expect(result.stale).to.equal(false)
    expect(result.saleRefs).to.deep.equal([])
    expect(result.causes).to.deep.equal([])
  })
})
