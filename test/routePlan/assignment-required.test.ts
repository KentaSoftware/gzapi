import { expect } from 'chai'

import { routePreviewRequestSchema } from '../../src/schemas/routeOptimization'

const baseRequest = {
  serviceDate: '2026-10-12',
  deliveryZoneId: '507f1f77bcf86cd799439011',
  saleIds: ['507f1f77bcf86cd799439012']
}

describe('Route assignment requirements', () => {
  it('S-31: rejects preview and save input without a driver', () => {
    const result = routePreviewRequestSchema.safeParse({ ...baseRequest, vehicleId: 'vehicle-1' })

    expect(result.success).to.equal(false)
    if (!result.success) expect(result.error.issues.map((issue) => issue.path.join('.'))).to.include('driverId')
  })

  it('TC-026: rejects preview and save input without a vehicle', () => {
    const result = routePreviewRequestSchema.safeParse({ ...baseRequest, driverId: 'driver-1' })

    expect(result.success).to.equal(false)
    if (!result.success) expect(result.error.issues.map((issue) => issue.path.join('.'))).to.include('vehicleId')
  })

  it('S-31: names both missing assignments as actionable validation issues', () => {
    const result = routePreviewRequestSchema.safeParse(baseRequest)

    expect(result.success).to.equal(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).to.include.members(['driverId', 'vehicleId'])
    }
  })
})
