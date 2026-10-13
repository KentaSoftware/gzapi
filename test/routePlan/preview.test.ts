import { expect } from 'chai'

import { routePreviewRequestSchema } from '../../src/schemas/routeOptimization'

describe('Route preview dashboard contract', () => {
  it('TC-019: accepts the assigned vehicle input without monetary fields', () => {
    const result = routePreviewRequestSchema.safeParse({
      serviceDate: '2026-10-12',
      deliveryZoneId: '507f1f77bcf86cd799439011',
      saleIds: ['507f1f77bcf86cd799439012'],
      driverId: 'driver-1',
      vehicleId: 'vehicle-1'
    })

    expect(result.success).to.equal(true)
    if (result.success) expect(result.data).to.not.have.any.keys('price', 'currency', 'cost')
  })

  it('S-11: keeps assignment fields available even when fuel is unavailable', () => {
    const result = routePreviewRequestSchema.safeParse({
      serviceDate: '2026-10-12',
      deliveryZoneId: '507f1f77bcf86cd799439011',
      saleIds: ['507f1f77bcf86cd799439012'],
      driverId: 'driver-1',
      vehicleId: 'vehicle-without-consumption'
    })

    expect(result.success).to.equal(true)
  })
})
