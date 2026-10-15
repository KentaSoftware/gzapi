import { expect } from 'chai'
import { calculateFuelLiters, resolveAssignedConsumption } from '../../src/services/routeFuel'
import { ROUTE_METRIC_AVAILABILITY } from '../../src/interfaces/routeOptimization.interface'

describe('Route fuel calculations', () => {
  it('TC-019: calculates physical fuel liters from distance and assigned consumption', () => {
    expect(calculateFuelLiters(125, 8.4)).to.equal(10.5)
  })

  it('S-11: reports unavailable consumption when no vehicle is assigned', () => {
    expect(resolveAssignedConsumption(null)).to.equal(null)
    expect(ROUTE_METRIC_AVAILABILITY.UNAVAILABLE).to.equal('UNAVAILABLE')
  })

  it('NFR-004: rejects non-finite or negative fuel inputs', () => {
    expect(() => calculateFuelLiters(-1, 8)).to.throw()
    expect(() => calculateFuelLiters(1, Number.NaN)).to.throw()
  })
})
