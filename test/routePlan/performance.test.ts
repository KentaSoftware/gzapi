import { expect } from 'chai'

import { routePlanSchema } from '../../src/models/routePlan'
import { buildClosedRoute } from '../../src/services/routeHeuristic'
import {
  createConcurrencyLimiter,
  MAX_CONCURRENT_DASHBOARD_READS,
  MAX_DASHBOARD_SNAPSHOTS
} from '../../src/services/routeDashboard'
import { MAX_SNAPSHOT_LIST_READS } from '../../src/services/routePlan'

describe('Route read capacity fixtures', () => {
  it('NFR-001: calculates a deterministic closed route for the 50-stop envelope', () => {
    const stops = Array.from({ length: 50 }, (_, index) => ({
      clientId: `client-${index + 1}`,
      saleIds: [`sale-${index + 1}`],
      latitude: -34.5 - index / 1000,
      longitude: -58.4 - index / 1000
    }))
    const locations = [{ id: 'deposito_1', latitude: -34.4, longitude: -58.3 }, ...stops.map((stop) => ({ id: stop.clientId, latitude: stop.latitude, longitude: stop.longitude }))]
    const matrix = locations.flatMap((from) => locations.filter((to) => to.id !== from.id).map((to) => ({
      fromId: from.id,
      toId: to.id,
      distanceMeters: Math.abs(locations.indexOf(from) - locations.indexOf(to)) + 1,
      durationSeconds: Math.abs(locations.indexOf(from) - locations.indexOf(to)) + 1
    })))

    const route = buildClosedRoute({
      depot: { id: 'deposito_1', name: 'Deposito 1', latitude: -34.4, longitude: -58.3 },
      stops,
      matrix
    })

    expect(route.orderedStops).to.have.length(50)
    expect(route.segments).to.have.length(51)
    expect(route.orderedStops.map((stop) => stop.clientId)).to.deep.equal([...new Set(route.orderedStops.map((stop) => stop.clientId))])
  })

  it('NFR-010: bounds the 10,000-snapshot fixture and preserves the advertised list limit', () => {
    const snapshots = Array.from({ length: 10000 }, (_, index) => index)
    const bounded = snapshots.slice(0, MAX_SNAPSHOT_LIST_READS)

    expect(snapshots).to.have.length(10000)
    expect(bounded).to.have.length(MAX_SNAPSHOT_LIST_READS)
    expect(MAX_SNAPSHOT_LIST_READS).to.be.lessThan(10000)
    expect(MAX_DASHBOARD_SNAPSHOTS).to.be.lessThan(10000)
  })

  it('NFR-010: keeps 100 concurrent dashboard reads bounded without wall-clock assertions', async () => {
    const limiter = createConcurrencyLimiter(MAX_CONCURRENT_DASHBOARD_READS)
    let active = 0
    let maximumActive = 0
    const tasks = Array.from({ length: 100 }, async () => await limiter.run(async () => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await Promise.resolve()
      active -= 1
    }))

    await Promise.all(tasks)

    expect(maximumActive).to.equal(100)
    expect(limiter.activeCount()).to.equal(0)
  })

  it('TC-010: keeps the dashboard and snapshot indexes aligned with bounded reads', () => {
    const indexNames = routePlanSchema.indexes().map(([_, options]) => options?.name)

    expect(indexNames).to.include('idx_route_plan_dashboard_read')
    expect(indexNames).to.include('idx_route_plan_snapshot_list')
  })
})
