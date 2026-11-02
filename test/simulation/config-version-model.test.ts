import { expect } from 'chai'
import { Types } from 'mongoose'

import { SIMULATION_RECORD_STATUSES } from '../../src/interfaces/simulation.interface'
import SimulationConfigVersionModel, {
  assertConfigVersionUpdateAllowed
} from '../../src/models/simulationConfigVersion'
import { USER_ID, validConfigVersion } from './fixtures'
import { executePreHook, expectHookRejection, hasIndex } from './mongoose-hooks'

describe('Simulation persistence - versioned configuration model', () => {
  it('TC-012: requires author, approval, scope, values, and reason', () => {
    const missing = new SimulationConfigVersionModel()
    const missingError = missing.validateSync()

    expect(missingError?.errors.version).to.not.equal(undefined)
    expect(missingError?.errors.vehicleCode).to.not.equal(undefined)
    expect(missingError?.errors.zoneCode).to.not.equal(undefined)
    expect(missingError?.errors.period).to.not.equal(undefined)
    expect(missingError?.errors.values).to.not.equal(undefined)
    expect(missingError?.errors.reason).to.not.equal(undefined)
    expect(missingError?.errors.createdBy).to.not.equal(undefined)
    expect(missingError?.errors.approvedBy).to.not.equal(undefined)
    expect(missingError?.errors.approvalId).to.not.equal(undefined)
    expect(new SimulationConfigVersionModel(validConfigVersion).validateSync()).to.equal(undefined)
  })

  it('TC-012: rejects malformed configuration values and scope identifiers', () => {
    const invalidKey = new SimulationConfigVersionModel({
      ...validConfigVersion,
      values: { 'bad key': 1 }
    })
    expect(invalidKey.validateSync()?.errors.values).to.not.equal(undefined)

    const invalidLimit = new SimulationConfigVersionModel({
      ...validConfigVersion,
      limits: { demandMaximum: Number.POSITIVE_INFINITY }
    })
    expect(invalidLimit.validateSync()?.errors.limits).to.not.equal(undefined)

    const invalidVehicle = new SimulationConfigVersionModel({
      ...validConfigVersion,
      vehicleCode: 'V 01!'
    })
    expect(invalidVehicle.validateSync()?.errors.vehicleCode).to.not.equal(undefined)
  })

  it('TC-012: declares a unique logical version and validity index', () => {
    expect(hasIndex(SimulationConfigVersionModel.schema, {
      vehicleCode: 1,
      zoneCode: 1,
      'period.from': 1,
      'period.to': 1,
      version: 1
    }, true)).to.equal(true)
    expect(hasIndex(SimulationConfigVersionModel.schema, { status: 1, 'period.from': 1, 'period.to': 1 })).to.equal(true)
  })

  it('TC-012: permits archive updates but rejects value rewrites', () => {
    expect(() => assertConfigVersionUpdateAllowed({ $set: { status: SIMULATION_RECORD_STATUSES.ARCHIVED, archivedAt: new Date() } })).to.not.throw()
    expect(() => assertConfigVersionUpdateAllowed({ $set: { values: { fuelPricePerLiter: 1 } } })).to.throw()
    expect(() => assertConfigVersionUpdateAllowed({ $set: { updatedAt: new Date() } })).to.throw()
    expect(() => assertConfigVersionUpdateAllowed({ $unset: { approvalId: '' } })).to.throw()
  })

  it('TC-012: validates status values on permitted update paths', () => {
    expect(() => assertConfigVersionUpdateAllowed({ $set: { status: SIMULATION_RECORD_STATUSES.ACTIVE } })).to.not.throw()
    expect(() => assertConfigVersionUpdateAllowed({ $set: { status: SIMULATION_RECORD_STATUSES.ARCHIVED } })).to.not.throw()
    expect(() => assertConfigVersionUpdateAllowed({ $set: { status: 'PENDING' } })).to.throw()
    expect(() => assertConfigVersionUpdateAllowed({ $set: { status: 'archived' } })).to.throw()
    expect(() => assertConfigVersionUpdateAllowed({ $set: { status: ['ARCHIVED'] } })).to.throw()
    expect(() => assertConfigVersionUpdateAllowed({ $set: { status: null } })).to.throw()
  })

  it('TC-012: installed configuration middleware rejects unsupported status values', async () => {
    const deniedStatusUpdate = SimulationConfigVersionModel.updateOne({ _id: USER_ID }, { $set: { status: 'PENDING' } })
    await expectHookRejection(SimulationConfigVersionModel.schema, 'updateOne', deniedStatusUpdate)

    const deniedStatusFind = SimulationConfigVersionModel.findOneAndUpdate({ _id: USER_ID }, { $set: { status: 'PENDING' } })
    await expectHookRejection(SimulationConfigVersionModel.schema, 'findOneAndUpdate', deniedStatusFind)

    const allowedStatusUpdate = SimulationConfigVersionModel.updateOne({ _id: USER_ID }, { $set: { status: SIMULATION_RECORD_STATUSES.ACTIVE } })
    await executePreHook(SimulationConfigVersionModel.schema, 'updateOne', allowedStatusUpdate)
  })

  it('TC-012: installed configuration middleware blocks evidence and permits archive', async () => {
    const allowedUpdate = SimulationConfigVersionModel.updateOne({ _id: USER_ID }, { $set: { status: SIMULATION_RECORD_STATUSES.ARCHIVED } })
    await executePreHook(SimulationConfigVersionModel.schema, 'updateOne', allowedUpdate)

    const deniedUpdate = SimulationConfigVersionModel.updateOne({ _id: USER_ID }, { $set: { values: { fuelPricePerLiter: 1 } } })
    await expectHookRejection(SimulationConfigVersionModel.schema, 'updateOne', deniedUpdate)

    const deniedSave = new SimulationConfigVersionModel({ ...validConfigVersion, createdBy: new Types.ObjectId(USER_ID) })
    deniedSave.isNew = false
    await expectHookRejection(SimulationConfigVersionModel.schema, 'save', deniedSave)

    const transition = SimulationConfigVersionModel.hydrate({
      ...validConfigVersion,
      createdBy: new Types.ObjectId(USER_ID),
      approvedBy: new Types.ObjectId(USER_ID)
    })
    transition.status = SIMULATION_RECORD_STATUSES.ARCHIVED
    transition.archivedAt = new Date()
    await executePreHook(SimulationConfigVersionModel.schema, 'save', transition)

    const timestampless = SimulationConfigVersionModel.updateOne({ _id: USER_ID }, {
      $set: { status: SIMULATION_RECORD_STATUSES.ARCHIVED, updatedAt: new Date('2000-01-01T00:00:00.000Z') }
    })
    void timestampless.setOptions({ timestamps: false })
    await executePreHook(SimulationConfigVersionModel.schema, 'updateOne', timestampless)
    const timestamplessUpdate = timestampless.getUpdate() as { $set?: Record<string, unknown> }
    expect(timestamplessUpdate.$set?.updatedAt).to.equal(undefined)
  })
})
