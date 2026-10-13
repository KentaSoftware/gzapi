import { expect } from 'chai'
import {
  buildLegacyOperationalProjection,
  getNextBackfillCheckpoint,
  resolveLegacyOperationalStatus,
  type LegacySnapshot,
  type LegacySale
} from '../../migrations/route-plan-004-backfill-dashboard'

describe('Route dashboard backfill migration helpers', () => {
  it('TC-030: keeps legacy status pending when delivery evidence is incomplete', () => {
    const snapshot: LegacySnapshot = { _id: 'snapshot-1', selectedSaleIds: ['sale-1', 'sale-2'] }
    const sales: LegacySale[] = [{ _id: 'sale-1', delivery: { status: 'DELIVERED' } }]

    expect(resolveLegacyOperationalStatus(snapshot, sales)).to.equal('PENDING')
  })

  it('TC-031: creates an unassigned projection with unavailable legacy metrics', () => {
    const snapshot: LegacySnapshot = {
      _id: 'snapshot-1',
      selectedSaleIds: ['sale-1'],
      audit: { createdAt: new Date('2026-01-02T03:04:05.000Z') }
    }
    const projection = buildLegacyOperationalProjection(snapshot, [], new Date('2026-01-03T00:00:00.000Z'))

    expect(projection).to.deep.equal({
      snapshotId: 'snapshot-1',
      status: 'PENDING',
      sourceDeliveryVersion: 0,
      assignments: {},
      history: [{ status: 'PENDING', changedBy: 'route-plan-004-backfill', changedAt: new Date('2026-01-02T03:04:05.000Z'), version: 1 }],
      version: 1,
      updatedBy: 'route-plan-004-backfill',
      stale: false
    })
  })

  it('TC-032: advances a bounded checkpoint from the last processed snapshot', () => {
    expect(getNextBackfillCheckpoint([{ _id: 'a' }, { _id: 'b' }])).to.equal('b')
    expect(getNextBackfillCheckpoint([])).to.equal(null)
  })
})
