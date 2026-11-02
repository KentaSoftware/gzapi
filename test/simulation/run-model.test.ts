import { expect } from 'chai'
import { Types } from 'mongoose'

import {
  SIMULATION_DATA_QUALITY,
  SIMULATION_RECORD_STATUSES,
  type SimulationRun
} from '../../src/interfaces/simulation.interface'
import SimulationRunModel, {
  assertRunDocumentTransitionAllowed,
  assertRunUpdateAllowed
} from '../../src/models/simulationRun'
import {
  CAPTURED_AT,
  PRODUCT_ID,
  USER_ID,
  validCalculation,
  validRouteSnapshot,
  validRun,
  validStockSnapshot,
  validVariant
} from './fixtures'
import { executePreHook, expectHookRejection, hasIndex } from './mongoose-hooks'

describe('Simulation persistence - run model', () => {
  it('TC-012: requires frozen route, stock, input, result, and version evidence', () => {
    const missing = new SimulationRunModel()
    const missingError = missing.validateSync()

    expect(missingError?.errors.status).to.not.equal(undefined)
    expect(missingError?.errors.createdBy).to.not.equal(undefined)
    expect(missingError?.errors.sourceRouteId).to.not.equal(undefined)
    expect(missingError?.errors.routeSnapshot).to.not.equal(undefined)
    expect(missingError?.errors.stockSnapshot).to.not.equal(undefined)
    expect(missingError?.errors.baseScenarioHash).to.not.equal(undefined)
    expect(missingError?.errors.variant).to.not.equal(undefined)
    expect(missingError?.errors.calculation).to.not.equal(undefined)
    expect(missingError?.errors.versions).to.not.equal(undefined)

    expect(new SimulationRunModel(validRun).validateSync()).to.equal(undefined)
    expect(SimulationRunModel.schema.path('createdBy').options.ref).to.equal('user')
    expect(SimulationRunModel.schema.path('routeSnapshot').options.immutable).to.equal(true)
    expect(SimulationRunModel.schema.path('stockSnapshot').options.immutable).to.equal(true)
    expect(SimulationRunModel.schema.path('baseScenarioHash').options.immutable).to.equal(true)
    expect(SimulationRunModel.schema.path('variant').options.immutable).to.equal(true)
    expect(SimulationRunModel.schema.path('calculation').options.immutable).to.equal(true)
    expect(SimulationRunModel.schema.path('versions').options.immutable).to.equal(true)
  })

  it('TC-012: rejects incomplete persisted run evidence', () => {
    const incompleteRoute = new SimulationRunModel({
      ...validRun,
      routeSnapshot: { ...validRouteSnapshot, capacity: undefined }
    })
    expect(incompleteRoute.validateSync()?.errors.routeSnapshot).to.not.equal(undefined)

    const incompleteStock = new SimulationRunModel({
      ...validRun,
      stockSnapshot: {
        ...validStockSnapshot,
        products: [{ ...validStockSnapshot.products[0], presalePriceArs: undefined }]
      }
    })
    expect(incompleteStock.validateSync()?.errors.stockSnapshot).to.not.equal(undefined)

    const incompleteVariant = new SimulationRunModel({
      ...validRun,
      variant: {
        ...validVariant,
        directLoad: [{ productId: PRODUCT_ID, quantity: 10, projectedSalesQuantity: 11 }]
      }
    })
    expect(incompleteVariant.validateSync()?.errors.variant).to.not.equal(undefined)

    const missingTotals = new SimulationRunModel({
      ...validRun,
      calculation: { ...validCalculation, totals: undefined }
    })
    expect(missingTotals.validateSync()?.errors.calculation).to.not.equal(undefined)

    const missingAmount = new SimulationRunModel({
      ...validRun,
      calculation: { ...validCalculation, components: [{ code: 'fuel', amountArs: undefined }] }
    })
    expect(missingAmount.validateSync()?.errors.calculation).to.not.equal(undefined)

    const inconsistentRecommendation = new SimulationRunModel({
      ...validRun,
      calculation: {
        ...validCalculation,
        dataQuality: SIMULATION_DATA_QUALITY.INCOMPLETE
      }
    })
    expect(inconsistentRecommendation.validateSync()?.errors.calculation).to.not.equal(undefined)
  })

  it('TC-012: rejects status values outside the reversible lifecycle', () => {
    expect(new SimulationRunModel({ ...validRun, status: 'DELETED' }).validateSync()?.errors.status).to.not.equal(undefined)
  })

  it('TC-012: declares history and status indexes', () => {
    expect(hasIndex(SimulationRunModel.schema, { sourceRouteId: 1, createdAt: -1 })).to.equal(true)
    expect(hasIndex(SimulationRunModel.schema, { status: 1, createdAt: -1 })).to.equal(true)
    expect(SimulationRunModel.schema.options.versionKey).to.equal(false)
  })

  it('TC-012: allows only status transition updates on stored runs', () => {
    expect(() => assertRunUpdateAllowed({ $set: { status: SIMULATION_RECORD_STATUSES.ARCHIVED, archivedAt: new Date(), archivedBy: USER_ID } })).to.not.throw()
    expect(() => assertRunUpdateAllowed({ $set: { status: SIMULATION_RECORD_STATUSES.ACTIVE }, $unset: { archivedAt: '', archivedBy: '' } })).to.not.throw()
    expect(() => assertRunUpdateAllowed({ $set: { baseScenarioHash: 'b'.repeat(64) } })).to.throw()
    expect(() => assertRunUpdateAllowed({ $set: { 'calculation.marginArs': 1 } })).to.throw()
    expect(() => assertRunUpdateAllowed({ $set: { updatedAt: new Date() } })).to.throw()
    expect(() => assertRunUpdateAllowed({ $unset: { routeSnapshot: '' } })).to.throw()
    expect(() => assertRunUpdateAllowed({ $inc: { 'calculation.totals.marginArs': 1 } })).to.throw()
    expect(() => assertRunUpdateAllowed({ status: SIMULATION_RECORD_STATUSES.ARCHIVED })).to.throw()
  })

  it('TC-012: rejects status values outside the run model contract on guarded update documents', () => {
    expect(() => assertRunUpdateAllowed({ $set: { status: 'DELETED' } })).to.throw()
    expect(() => assertRunUpdateAllowed({ $set: { status: 'active' } })).to.throw()
    expect(() => assertRunUpdateAllowed({ $set: { status: { $ne: null } } })).to.throw()
    expect(() => assertRunUpdateAllowed({ $set: { status: SIMULATION_RECORD_STATUSES.ACTIVE } })).to.not.throw()
  })

  it('TC-012: guarded update middleware rejects unknown status values', async () => {
    const invalidStatus = 'DELETED' as unknown as SimulationRun['status']

    const updateOne = SimulationRunModel.updateOne({ _id: USER_ID }, { $set: { status: invalidStatus } })
    await expectHookRejection(SimulationRunModel.schema, 'updateOne', updateOne)

    const updateMany = SimulationRunModel.updateMany({ _id: USER_ID }, { $set: { status: invalidStatus } })
    await expectHookRejection(SimulationRunModel.schema, 'updateMany', updateMany)

    const findOneAndUpdate = SimulationRunModel.findOneAndUpdate({ _id: USER_ID }, { $set: { status: invalidStatus } })
    await expectHookRejection(SimulationRunModel.schema, 'findOneAndUpdate', findOneAndUpdate)
  })

  it('TC-012: rejects model-level bulkWrite so query guards cannot be bypassed', async () => {
    await expectHookRejection(SimulationRunModel.schema, 'bulkWrite', {})
  })

  it('TC-012: installed run middleware blocks evidence and permits lifecycle transitions', async () => {
    const allowedUpdate = SimulationRunModel.updateOne({ _id: USER_ID }, { $set: { status: SIMULATION_RECORD_STATUSES.ARCHIVED } })
    await executePreHook(SimulationRunModel.schema, 'updateOne', allowedUpdate)

    const deniedUpdate = SimulationRunModel.updateOne({ _id: USER_ID }, { $set: { baseScenarioHash: 'b'.repeat(64) } })
    await expectHookRejection(SimulationRunModel.schema, 'updateOne', deniedUpdate)

    const deniedSave = new SimulationRunModel({ ...validRun, createdBy: new Types.ObjectId(USER_ID) })
    deniedSave.isNew = false
    await expectHookRejection(SimulationRunModel.schema, 'save', deniedSave)

    const transition = SimulationRunModel.hydrate({
      ...validRun,
      createdBy: new Types.ObjectId(USER_ID),
      versions: { ...validRun.versions, calculatedAt: new Date(CAPTURED_AT) }
    })
    transition.status = SIMULATION_RECORD_STATUSES.ARCHIVED
    transition.archivedAt = new Date()
    transition.archivedBy = new Types.ObjectId(USER_ID)
    await executePreHook(SimulationRunModel.schema, 'save', transition)

    const deniedDelete = SimulationRunModel.deleteOne({ _id: USER_ID })
    await expectHookRejection(SimulationRunModel.schema, 'deleteOne', deniedDelete)
  })

  it('TC-012: strips caller timestamps from actual updates and rejects overwriteImmutable', async () => {
    const forgedTimestamp = new Date('2000-01-01T00:00:00.000Z')

    const timestampless = SimulationRunModel.updateOne({ _id: USER_ID }, {
      $set: {
        status: SIMULATION_RECORD_STATUSES.ARCHIVED,
        updatedAt: forgedTimestamp,
        createdAt: forgedTimestamp
      }
    })
    void timestampless.setOptions({ timestamps: false })
    await executePreHook(SimulationRunModel.schema, 'updateOne', timestampless)
    const timestamplessUpdate = timestampless.getUpdate() as { $set?: Record<string, unknown> }
    expect(timestamplessUpdate.$set?.updatedAt).to.equal(undefined)
    expect(timestamplessUpdate.$set?.createdAt).to.equal(undefined)
    expect(timestamplessUpdate.$set?.status).to.equal(SIMULATION_RECORD_STATUSES.ARCHIVED)

    const managed = SimulationRunModel.updateOne({ _id: USER_ID }, {
      $set: { status: SIMULATION_RECORD_STATUSES.ARCHIVED, updatedAt: forgedTimestamp, createdAt: forgedTimestamp },
      $setOnInsert: { createdAt: forgedTimestamp }
    })
    await executePreHook(SimulationRunModel.schema, 'updateOne', managed)
    const managedUpdate = managed.getUpdate() as {
      $set?: Record<string, unknown>
      $setOnInsert?: Record<string, unknown>
    }
    expect(managedUpdate.$set?.updatedAt).to.be.instanceOf(Date)
    expect((managedUpdate.$set?.updatedAt as Date).getTime()).to.not.equal(forgedTimestamp.getTime())
    expect(managedUpdate.$set?.createdAt).to.equal(undefined)
    expect(managedUpdate.$setOnInsert?.createdAt).to.be.instanceOf(Date)
    expect((managedUpdate.$setOnInsert?.createdAt as Date).getTime()).to.not.equal(forgedTimestamp.getTime())

    const overwriteImmutable = SimulationRunModel.updateOne({ _id: USER_ID }, {
      $set: { status: SIMULATION_RECORD_STATUSES.ARCHIVED }
    })
    void overwriteImmutable.setOptions({ overwriteImmutable: true })
    await expectHookRejection(SimulationRunModel.schema, 'updateOne', overwriteImmutable)
  })

  it('TC-012: allows document saves only for lifecycle fields after creation', () => {
    expect(() => assertRunDocumentTransitionAllowed(true, ['status', 'calculation'])).to.not.throw()
    expect(() => assertRunDocumentTransitionAllowed(false, ['status', 'archivedAt', 'archivedBy'])).to.not.throw()
    expect(() => assertRunDocumentTransitionAllowed(false, ['updatedAt'])).to.throw()
    expect(() => assertRunDocumentTransitionAllowed(false, ['calculation'])).to.throw()
    expect(() => assertRunDocumentTransitionAllowed(false, ['routeSnapshot'])).to.throw()
  })
})
