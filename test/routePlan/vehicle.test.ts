import { expect } from 'chai'
import proxyquire from 'proxyquire'

import { vehicleSchema } from '../../src/schemas/vehicle'
import VehicleModel, { vehicleMongooseSchema } from '../../src/models/vehicle'

describe('Vehicle assignment contract', () => {
  it('TC-018: requires a unique plate code and active/read fields', () => {
    const valid = vehicleSchema.safeParse({
      code: ' AA123AA ',
      fuelConsumptionLitersPer100Km: 12.5,
      attributes: { type: 'van' },
      active: true
    })
    const missingCode = vehicleSchema.safeParse({ fuelConsumptionLitersPer100Km: 12.5 })
    const invalidConsumption = vehicleSchema.safeParse({ code: 'AA123AA', fuelConsumptionLitersPer100Km: 0 })

    expect(valid.success).to.equal(true)
    expect(missingCode.success).to.equal(false)
    expect(invalidConsumption.success).to.equal(false)
    expect(vehicleMongooseSchema.path('code').options.unique).to.equal(true)
    expect(vehicleMongooseSchema.path('active')).to.not.equal(undefined)
    expect(JSON.stringify(vehicleMongooseSchema.obj)).to.not.match(/price|currency|cost/i)
  })

  it('TC-019: reads selectable active vehicles and resolves a vehicle by id without writes', async () => {
    const selectable = { id: 'vehicle-1', code: 'AA123AA', fuelConsumptionLitersPer100Km: 12.5, attributes: {}, active: true }
    const findQuery = {
      select: () => findQuery,
      sort: () => findQuery,
      lean: async () => [selectable]
    }
    const fakeModel = {
      find: () => findQuery,
      findById: () => ({ select: () => ({ lean: async () => selectable }) })
    }
    const service = proxyquire('../../src/services/vehicle', { '../models/vehicle': { default: fakeModel } }) as typeof import('../../src/services/vehicle')

    const expected = { id: 'vehicle-1', code: 'AA123AA', fuelConsumptionLitersPer100Km: 12.5, attributes: {}, availability: true }
    expect(await service.listSelectableVehicles()).to.deep.equal([expected])
    expect(await service.getVehicleById('vehicle-1')).to.deep.equal(expected)
    expect(VehicleModel.schema.path('code')).to.not.equal(undefined)
  })
})
