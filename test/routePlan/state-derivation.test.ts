import { expect } from 'chai'
import { SALE_DELIVERY_STATUS } from '../../src/interfaces/sale.interface'
import { ROUTE_OPERATIONAL_STATUS } from '../../src/interfaces/routeOptimization.interface'
import { deriveRouteStatus } from '../../src/services/routeStateDerivation'

describe('Route state derivation', () => {
  it('S-25: derives pending when no selected sale is delivered', () => {
    expect(deriveRouteStatus([SALE_DELIVERY_STATUS.PENDING])).to.equal(ROUTE_OPERATIONAL_STATUS.PENDING)
  })

  it('S-26: derives in progress for a partially delivered selection', () => {
    expect(deriveRouteStatus([SALE_DELIVERY_STATUS.DELIVERED, SALE_DELIVERY_STATUS.PENDING])).to.equal(ROUTE_OPERATIONAL_STATUS.IN_PROGRESS)
  })

  it('S-26: derives completed only when every selected sale is delivered', () => {
    expect(deriveRouteStatus([SALE_DELIVERY_STATUS.DELIVERED, SALE_DELIVERY_STATUS.DELIVERED])).to.equal(ROUTE_OPERATIONAL_STATUS.COMPLETED)
  })

  it('NFR-004: rejects an empty selection as non-routable', () => {
    expect(() => deriveRouteStatus([])).to.throw()
  })
})
