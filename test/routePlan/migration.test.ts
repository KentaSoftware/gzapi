import { expect } from 'chai'
import {
  applyRouteDashboardIndexes,
  ROUTE_PLAN_DASHBOARD_INDEXES,
  type MongoDatabase
} from '../../migrations/route-plan-003-expand-dashboard'

describe('Route dashboard expand migration', () => {
  it('S-21: declares only additive snapshot and operational indexes', () => {
    expect(ROUTE_PLAN_DASHBOARD_INDEXES.map((index) => index[0])).to.deep.equal([
      'routeplans',
      'routeplans',
      'routeplans',
      'routeplanoperationals',
      'routeplanoperationals',
      'routeplanoperationals',
      'routeplanoperationals'
    ])
    expect(ROUTE_PLAN_DASHBOARD_INDEXES.map((index) => index[2].name)).to.deep.equal([
      'idx_route_plan_sale_reference',
      'idx_route_plan_fuel_availability_date',
      'idx_route_plan_schedule_calculated_date',
      'idx_unique_route_plan_operational_snapshot',
      'idx_route_plan_operational_status_stale_date',
      'idx_route_plan_operational_driver_date',
      'idx_route_plan_operational_vehicle_date'
    ])
  })

  it('NFR-004: reruns with stable index names and performs no destructive operation', () => {
    const calls: Array<{ collection: string, name: string }> = []
    const database: MongoDatabase = {
      getCollection: (collection) => ({
        createIndex: (_keys, options) => {
          calls.push({ collection, name: options.name })
        }
      })
    }

    applyRouteDashboardIndexes(database)
    applyRouteDashboardIndexes(database)

    expect(calls).to.have.length(ROUTE_PLAN_DASHBOARD_INDEXES.length * 2)
    expect(calls.slice(0, ROUTE_PLAN_DASHBOARD_INDEXES.length)).to.deep.equal(
      calls.slice(ROUTE_PLAN_DASHBOARD_INDEXES.length)
    )
  })
})
