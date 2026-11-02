import { expect } from 'chai'
import { Types } from 'mongoose'

import { SIMULATION_RECORD_STATUSES } from '../../src/interfaces/simulation.interface'
import SimulationPresetVersionModel, {
  assertPresetVersionUpdateAllowed
} from '../../src/models/simulationPresetVersion'
import { PRODUCT_ID, USER_ID, validPresetVersion } from './fixtures'
import { executePreHook, expectHookRejection, hasIndex } from './mongoose-hooks'

describe('Simulation persistence - versioned preset model', () => {
  it('TC-012: requires name, version, definition, author, and reason', () => {
    const missing = new SimulationPresetVersionModel()
    const missingError = missing.validateSync()

    expect(missingError?.errors.name).to.not.equal(undefined)
    expect(missingError?.errors.version).to.not.equal(undefined)
    expect(missingError?.errors.definition).to.not.equal(undefined)
    expect(missingError?.errors.reason).to.not.equal(undefined)
    expect(missingError?.errors.createdBy).to.not.equal(undefined)
    expect(new SimulationPresetVersionModel(validPresetVersion).validateSync()).to.equal(undefined)
  })

  it('TC-012: rejects malformed preset definitions and names', () => {
    const invalidOverride = new SimulationPresetVersionModel({
      ...validPresetVersion,
      definition: { overrides: [{ key: 'fuelPricePerLiter', value: undefined }], directLoad: [] }
    })
    expect(invalidOverride.validateSync()?.errors.definition).to.not.equal(undefined)

    const invalidDirectLoad = new SimulationPresetVersionModel({
      ...validPresetVersion,
      definition: {
        overrides: [],
        directLoad: [{ productId: PRODUCT_ID, quantity: 1, projectedSalesQuantity: 2 }]
      }
    })
    expect(invalidDirectLoad.validateSync()?.errors.definition).to.not.equal(undefined)

    const invalidName = new SimulationPresetVersionModel({ ...validPresetVersion, name: 'Preset!' })
    expect(invalidName.validateSync()?.errors.name).to.not.equal(undefined)
  })

  it('TC-012: declares unique preset versions and a status index', () => {
    expect(hasIndex(SimulationPresetVersionModel.schema, { name: 1, version: 1 }, true)).to.equal(true)
    expect(hasIndex(SimulationPresetVersionModel.schema, { status: 1, createdAt: -1 })).to.equal(true)
  })

  it('TC-012: permits archive updates but rejects definition rewrites', () => {
    expect(() => assertPresetVersionUpdateAllowed({ $set: { status: SIMULATION_RECORD_STATUSES.ARCHIVED, archivedAt: new Date() } })).to.not.throw()
    expect(() => assertPresetVersionUpdateAllowed({ $set: { definition: { overrides: [], directLoad: [] } } })).to.throw()
    expect(() => assertPresetVersionUpdateAllowed({ $set: { updatedAt: new Date() } })).to.throw()
    expect(() => assertPresetVersionUpdateAllowed({ $unset: { name: '' } })).to.throw()
  })

  it('TC-012: validates status values on permitted update paths', () => {
    expect(() => assertPresetVersionUpdateAllowed({ $set: { status: SIMULATION_RECORD_STATUSES.ACTIVE } })).to.not.throw()
    expect(() => assertPresetVersionUpdateAllowed({ $set: { status: SIMULATION_RECORD_STATUSES.ARCHIVED } })).to.not.throw()
    expect(() => assertPresetVersionUpdateAllowed({ $set: { status: 'PENDING' } })).to.throw()
    expect(() => assertPresetVersionUpdateAllowed({ $set: { status: 'archived' } })).to.throw()
    expect(() => assertPresetVersionUpdateAllowed({ $set: { status: ['ARCHIVED'] } })).to.throw()
    expect(() => assertPresetVersionUpdateAllowed({ $set: { status: null } })).to.throw()
  })

  it('TC-012: installed preset middleware rejects unsupported status values', async () => {
    const deniedStatusUpdate = SimulationPresetVersionModel.updateOne({ _id: USER_ID }, { $set: { status: 'PENDING' } })
    await expectHookRejection(SimulationPresetVersionModel.schema, 'updateOne', deniedStatusUpdate)

    const deniedStatusFind = SimulationPresetVersionModel.findOneAndUpdate({ _id: USER_ID }, { $set: { status: 'PENDING' } })
    await expectHookRejection(SimulationPresetVersionModel.schema, 'findOneAndUpdate', deniedStatusFind)

    const allowedStatusUpdate = SimulationPresetVersionModel.updateOne({ _id: USER_ID }, { $set: { status: SIMULATION_RECORD_STATUSES.ACTIVE } })
    await executePreHook(SimulationPresetVersionModel.schema, 'updateOne', allowedStatusUpdate)
  })

  it('TC-012: installed preset middleware blocks evidence and permits archive', async () => {
    const allowedUpdate = SimulationPresetVersionModel.updateOne({ _id: USER_ID }, { $set: { status: SIMULATION_RECORD_STATUSES.ARCHIVED } })
    await executePreHook(SimulationPresetVersionModel.schema, 'updateOne', allowedUpdate)

    const deniedUpdate = SimulationPresetVersionModel.updateOne({ _id: USER_ID }, { $set: { definition: { overrides: [], directLoad: [] } } })
    await expectHookRejection(SimulationPresetVersionModel.schema, 'updateOne', deniedUpdate)

    const deniedSave = new SimulationPresetVersionModel({ ...validPresetVersion, createdBy: new Types.ObjectId(USER_ID) })
    deniedSave.isNew = false
    await expectHookRejection(SimulationPresetVersionModel.schema, 'save', deniedSave)

    const transition = SimulationPresetVersionModel.hydrate({
      ...validPresetVersion,
      createdBy: new Types.ObjectId(USER_ID)
    })
    transition.status = SIMULATION_RECORD_STATUSES.ARCHIVED
    transition.archivedAt = new Date()
    await executePreHook(SimulationPresetVersionModel.schema, 'save', transition)

    const timestampless = SimulationPresetVersionModel.updateOne({ _id: USER_ID }, {
      $set: { status: SIMULATION_RECORD_STATUSES.ARCHIVED, updatedAt: new Date('2000-01-01T00:00:00.000Z') }
    })
    void timestampless.setOptions({ timestamps: false })
    await executePreHook(SimulationPresetVersionModel.schema, 'updateOne', timestampless)
    const timestamplessUpdate = timestampless.getUpdate() as { $set?: Record<string, unknown> }
    expect(timestamplessUpdate.$set?.updatedAt).to.equal(undefined)
  })
})
