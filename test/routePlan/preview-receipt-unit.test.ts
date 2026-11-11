import { expect } from 'chai'
import sinon from 'sinon'
import { mongo, Types } from 'mongoose'
import { routeSaveRequestSchema } from '../../src/schemas/routeOptimization'
import ReceiptModel from '../../src/models/routePlanPreviewReceipt'
import RoutePlanModel from '../../src/models/routePlan'
import SaleModel from '../../src/models/sale'
import ClientModel from '../../src/models/client'
import ItemSaleModel from '../../src/models/itemSale'
import ZoneModel from '../../src/models/deliveryZone'
import ConfigModel from '../../src/models/routingConfig'
import * as provider from '../../src/services/routeMatrixProvider'
import * as vehicles from '../../src/services/vehicle'
import { preview, saveSnapshot, saveLegacySnapshot } from '../../src/services/routePlan'
import { assignmentGuard } from '../../src/services/routeAssignment'

describe('route preview receipt contract', () => {
  it('accepts only an opaque receipt and rejects legacy or arbitrary preview data', () => {
    expect(routeSaveRequestSchema.safeParse({ receipt: 'a'.repeat(64) }).success).to.equal(true)
    expect(routeSaveRequestSchema.safeParse({ saleIds: ['sale'] }).success).to.equal(false)
    expect(routeSaveRequestSchema.safeParse({ receipt: 'a'.repeat(64), metrics: { distanceMeters: 1 } }).success).to.equal(false)
  })
})

describe('route receipt service without database access', () => {
  const zoneId = new Types.ObjectId()
  const clientId = new Types.ObjectId()
  const saleId = new Types.ObjectId()
  const input = { serviceDate: '2026-11-08', deliveryZoneId: String(zoneId), saleIds: [String(saleId)], driverId: 'driver', vehicleId: 'vehicle', clientOrder: [String(clientId)] }
  const legacy = { serviceDate: input.serviceDate, deliveryZoneId: input.deliveryZoneId, saleIds: input.saleIds, driverId: input.driverId, vehicleId: input.vehicleId }
  const sale = { _id: saleId, idCliente: clientId, estado: 'Creado', updatedAt: new Date('2026-11-01'), delivery: { status: 'PENDING', serviceDate: new Date('2026-11-08T12:00:00Z') } }
  const client = { _id: clientId, nombreCompleto: 'Client', address: 'Address', isActive: true, deliveryZoneId: zoneId, lat: 1, lng: 2, geocoding: { status: 'CONFIRMED' } }
  const zone = { code: 'Z', name: 'Zone', normalizedName: 'zone' }
  const config = { depot: { name: 'Depot', latitude: 0, longitude: 0 }, provider: 'test', algorithm: 'test', revision: 1 }
  let stored: Record<string, unknown>
  let saved: Record<string, unknown> | null
  let claimed: boolean
  const query = (value: unknown): { sort: () => unknown, lean: () => Promise<unknown> } => {
    const result = { sort: () => result, lean: async () => value }
    return result
  }

  beforeEach(() => {
    sinon.stub(assignmentGuard, 'readIndexes').resolves([{ name: 'routeplan_reserved_sale_ids_unique', key: { reservedSaleIds: 1 }, unique: true, sparse: true }])
    sinon.stub(assignmentGuard, 'readCollectionOptions').resolves({})
    sinon.stub(assignmentGuard, 'readAssignedSnapshots').resolves([])
    sale.estado = 'Creado'
    stored = {}
    saved = null
    claimed = false
    sinon.stub(SaleModel, 'find').callsFake(() => query([sale]) as never)
    sinon.stub(ClientModel, 'find').callsFake(() => query([client]) as never)
    sinon.stub(ItemSaleModel, 'find').callsFake(() => query([]) as never)
    sinon.stub(ZoneModel, 'findOne').callsFake(() => query(zone) as never)
    sinon.stub(ConfigModel, 'findOne').callsFake(() => query(config) as never)
    const vehicle = { code: 'V', active: true, fuelConsumptionLitersPer100Km: 10 }
    sinon.stub(vehicles, 'getVehicleById').resolves(vehicle as never)
    sinon.stub(provider, 'computeMatrix').resolves({
      segments: [
        { fromId: 'deposito_1', toId: String(clientId), distanceMeters: 10, durationSeconds: 20 },
        { fromId: String(clientId), toId: 'deposito_1', distanceMeters: 11, durationSeconds: 21 }
      ]
    })
    sinon.stub(provider, 'computeRoute').resolves({ distanceMeters: 77, durationSeconds: 88, encodedPolyline: 'reviewed' })
    sinon.stub(ReceiptModel, 'create').callsFake(async (value: unknown) => { stored = value as Record<string, unknown>; return value as never })
    sinon.stub(ReceiptModel, 'findOneAndUpdate').callsFake((filter: unknown, update: unknown, options: unknown) => {
      const f = filter as { _id: string, actor?: string, tokenHash?: string, expiresAt?: { $gt: Date }, $or: Array<{ claimUntil: { $lte?: Date } }> }
      const u = update as { $set: Record<string, unknown> }
      const o = options as { upsert?: boolean }
      const now = f.$or[1].claimUntil.$lte as Date
      const active = claimed && (stored.claimUntil as Date).getTime() > now.getTime()
      if (o.upsert === true) {
        if (active) {
          const rejected = { lean: async () => { throw Object.assign(new Error('duplicate key'), { code: 11000 }) } }
          return rejected as never
        }
        stored = { _id: f._id, ...u.$set }
        claimed = false
        return query(stored) as never
      }
      const match = !active && stored._id === f._id && stored.actor === f.actor && stored.tokenHash === f.tokenHash && (stored.expiresAt as Date) > (f.expiresAt?.$gt as Date)
      if (match) { claimed = true; Object.assign(stored, u.$set) }
      return query(match ? { ...stored } : null) as never
    })
    sinon.stub(ReceiptModel, 'updateOne').callsFake(async (filter: unknown, update: unknown) => {
      const f = filter as { _id: string, actor?: string, tokenHash: string, claimId: string, claimUntil?: { $gt: Date }, expiresAt?: { $gt: Date } }
      const u = update as { $set?: Record<string, unknown>, $unset?: unknown }
      const match = stored._id === f._id && (f.actor === undefined || stored.actor === f.actor) && stored.tokenHash === f.tokenHash && stored.claimId === f.claimId &&
        (f.claimUntil === undefined || (stored.claimUntil as Date) > f.claimUntil.$gt) &&
        (f.expiresAt === undefined || (stored.expiresAt as Date) > f.expiresAt.$gt)
      if (match && u.$set !== undefined) Object.assign(stored, u.$set)
      if (match && u.$unset !== undefined) { claimed = false; delete stored.claimId; delete stored.claimUntil }
      const result = { matchedCount: match ? 1 : 0 }
      return result as never
    })
    sinon.stub(RoutePlanModel, 'findById').callsFake(() => query(saved) as never)
    sinon.stub(RoutePlanModel, 'create').callsFake(async (value: unknown) => { saved = value as Record<string, unknown>; return value as never })
  })
  afterEach(() => sinon.restore())

  it('accepts an undated pending sale and reserves it on both save paths', async () => {
    const previous = sale.delivery.serviceDate
    try {
      delete (sale.delivery as { serviceDate?: Date }).serviceDate
      const reviewed = await preview(input, { actor: 'actor' })
      const result = await saveSnapshot({ receipt: reviewed.receipt as string }, 'actor')
      expect(result.reservedSaleIds).to.deep.equal(input.saleIds)
      saved = null
      expect((await saveLegacySnapshot(legacy, 'actor')).reservedSaleIds).to.deep.equal(input.saleIds)
    } finally { sale.delivery.serviceDate = previous }
  })

  it('fails closed on missing index and rejects historical assignment on both paths', async () => {
    const reviewed = await preview(input, { actor: 'actor' })
    ;(assignmentGuard.readIndexes as sinon.SinonStub).resolves([])
    for (const action of [async () => await saveSnapshot({ receipt: reviewed.receipt as string }, 'actor'), async () => await saveLegacySnapshot(legacy, 'actor')]) {
      try { await action(); expect.fail('missing index') } catch (error) { expect((error as Error).name).to.equal('AssignmentSafetyError') }
    }
    ;(assignmentGuard.readIndexes as sinon.SinonStub).resolves([{ name: 'routeplan_reserved_sale_ids_unique', key: { reservedSaleIds: 1 }, unique: true, sparse: true }])
    ;(assignmentGuard.readAssignedSnapshots as sinon.SinonStub).resolves([{ selectedSaleIds: input.saleIds }])
    for (const action of [async () => await saveSnapshot({ receipt: reviewed.receipt as string }, 'actor'), async () => await saveLegacySnapshot(legacy, 'actor')]) {
      try { await action(); expect.fail('assigned') } catch (error) { expect((error as Error).name).to.equal('AssignmentConflictError') }
    }
    expect((RoutePlanModel.create as sinon.SinonStub).callCount).to.equal(0)
  })

  it('maps reservation index races but preserves unrelated duplicate errors', async () => {
    const reviewed = await preview(input, { actor: 'actor' })
    const create = RoutePlanModel.create as sinon.SinonStub
    create.onFirstCall().rejects(new mongo.MongoServerError({ message: 'duplicate', code: 11000, keyPattern: { reservedSaleIds: 1 } }))
    create.onSecondCall().rejects(new mongo.MongoServerError({ message: 'other duplicate', code: 11000, keyPattern: { _id: 1 } }))
    try { await saveSnapshot({ receipt: reviewed.receipt as string }, 'actor'); expect.fail('expected conflict') } catch (error) { expect((error as Error).name).to.equal('AssignmentConflictError') }
    try { await saveLegacySnapshot(legacy, 'actor'); expect.fail('expected error') } catch (error) { expect((error as Error).message).to.equal('other duplicate') }
  })

  it('maps only receipt snapshot _id collisions to receipt conflict', async () => {
    const reviewed = await preview(input, { actor: 'actor' })
    const error = new mongo.MongoServerError({ code: 11000, message: 'E11000 duplicate key error collection: test.routeplans index: _id_ dup key: { _id: ObjectId("a") }' })
    ;(RoutePlanModel.create as sinon.SinonStub).rejects(error)
    try { await saveSnapshot({ receipt: reviewed.receipt as string }, 'actor'); expect.fail('expected receipt conflict') } catch (caught) { expect((caught as { code?: string }).code).to.equal('PREVIEW_RECEIPT_CONFLICT') }
    try { await saveLegacySnapshot(legacy, 'actor'); expect.fail('expected original error') } catch (caught) { expect(caught).to.equal(error) }
  })

  it('accepts only the exact legacy shape or receipt, never mixed fields', () => {
    expect(routeSaveRequestSchema.safeParse(legacy).success).to.equal(true)
    expect(routeSaveRequestSchema.safeParse({ ...legacy, receipt: 'a'.repeat(64) }).success).to.equal(false)
    expect(routeSaveRequestSchema.safeParse({ ...legacy, receipt: 'invalid' }).success).to.equal(false)
    expect(routeSaveRequestSchema.safeParse({ ...legacy, metrics: {} }).success).to.equal(false)
    expect(routeSaveRequestSchema.safeParse({ ...legacy, clientOrder: input.clientOrder }).success).to.equal(false)
    expect(routeSaveRequestSchema.safeParse({ ...legacy, saleIds: [String(saleId), String(saleId)] }).success).to.equal(false)
  })

  it('recalculates legacy saves without issuing or invalidating a reviewed receipt', async () => {
    const reviewed = await preview(input, { actor: 'actor' })
    const issuanceCalls = (ReceiptModel.findOneAndUpdate as sinon.SinonStub).callCount
    const originalHash = stored.tokenHash
    ;(provider.computeRoute as sinon.SinonStub).resolves({ distanceMeters: 99, durationSeconds: 100, encodedPolyline: 'recalculated' })
    const result = await saveLegacySnapshot(legacy, 'actor')
    expect(result.metrics.distanceMeters).to.equal(99)
    expect(result.encodedPolyline).to.equal('recalculated')
    expect(result.audit.createdBy).to.equal('actor')
    expect((provider.computeRoute as sinon.SinonStub).callCount).to.equal(2)
    expect((ReceiptModel.findOneAndUpdate as sinon.SinonStub).callCount).to.equal(issuanceCalls)
    expect(stored.tokenHash).to.equal(originalHash)
    saved = null // The stub represents lookup of the distinct reviewed snapshot ID.
    expect((await saveSnapshot({ receipt: reviewed.receipt as string }, 'actor')).encodedPolyline).to.equal('reviewed')
  })

  it('leaves an active receipt claim untouched during a legacy save', async () => {
    await preview(input, { actor: 'actor' })
    claimed = true
    stored.claimUntil = new Date(Date.now() + 30000)
    const originalHash = stored.tokenHash
    const calls = (ReceiptModel.findOneAndUpdate as sinon.SinonStub).callCount
    await saveLegacySnapshot(legacy, 'actor')
    expect(claimed).to.equal(true)
    expect(stored.tokenHash).to.equal(originalHash)
    expect((ReceiptModel.findOneAndUpdate as sinon.SinonStub).callCount).to.equal(calls)
  })

  it('replaces the previous token in a single atomic actor slot', async () => {
    const first = await preview(input, { actor: 'actor' })
    const second = await preview(input, { actor: 'actor' })
    expect((ReceiptModel.create as sinon.SinonStub).callCount).to.equal(0)
    expect((ReceiptModel.findOneAndUpdate as sinon.SinonStub).callCount).to.equal(2)
    expect(stored._id).to.equal('actor')
    try { await saveSnapshot({ receipt: first.receipt as string }, 'actor'); expect.fail('old token must be invalid') } catch (error) { expect((error as Error).message).to.match(/receipt/i) }
    await saveSnapshot({ receipt: second.receipt as string }, 'actor')
  })

  it('uses one slot for simultaneous previews', async () => {
    const results = await Promise.all([preview(input, { actor: 'actor' }), preview(input, { actor: 'actor' })])
    expect((ReceiptModel.create as sinon.SinonStub).callCount).to.equal(0)
    expect((ReceiptModel.findOneAndUpdate as sinon.SinonStub).callCount).to.equal(2)
    expect(results[0].receipt).not.to.equal(results[1].receipt)
    const saves = await Promise.allSettled(results.map(async (result) => await saveSnapshot({ receipt: result.receipt as string }, 'actor')))
    expect(saves.filter((result) => result.status === 'fulfilled')).to.have.length(1)
  })

  it('does not replace a claimed slot before its lease expires', async () => {
    const first = await preview(input, { actor: 'actor' })
    claimed = true
    stored.claimUntil = new Date(Date.now() + 30000)
    try { await preview(input, { actor: 'actor' }); expect.fail('claimed slot must not be replaced') } catch (error) { expect((error as Error).message).to.match(/receipt/i) }
    expect(stored._id).to.equal('actor')
    stored.claimUntil = new Date(Date.now() - 1)
    const second = await preview(input, { actor: 'actor' })
    try { await saveSnapshot({ receipt: first.receipt as string }, 'actor'); expect.fail('old token must be invalid') } catch (error) { expect((error as Error).message).to.match(/receipt/i) }
    await saveSnapshot({ receipt: second.receipt as string }, 'actor')
  })

  it('rejects new issuance while a save is in progress and preserves that save', async () => {
    const first = await preview(input, { actor: 'actor' })
    let release: () => void = () => {}
    let started: () => void = () => {}
    const wait = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { started = resolve })
    const lookup = RoutePlanModel.findById as sinon.SinonStub
    lookup.callsFake(() => {
      const blocked = { lean: async () => { started(); await wait; return null } }
      return blocked as never
    })
    const saving = saveSnapshot({ receipt: first.receipt as string }, 'actor')
    await entered
    try { await preview(input, { actor: 'actor' }); expect.fail('claimed slot must not be replaced') } catch (error) { expect((error as Error).message).to.match(/receipt/i) }
    release()
    const snapshot = await saving
    expect(snapshot.encodedPolyline).to.equal(first.route.encodedPolyline)
    expect(snapshot.metrics).to.deep.equal(first.metrics)
  })

  it('rejects a stale save if its lease expires and a new preview replaces the slot during freshness checks', async () => {
    const clock = sinon.useFakeTimers({ now: Date.now() })
    const first = await preview(input, { actor: 'actor' })
    let release: () => void = () => {}
    let started: () => void = () => {}
    const wait = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { started = resolve })
    const vehicle = { code: 'V', active: true, fuelConsumptionLitersPer100Km: 10 }
    const lookup = vehicles.getVehicleById as sinon.SinonStub
    lookup.resetBehavior()
    lookup.resetHistory()
    lookup.onFirstCall().callsFake(async () => { started(); await wait; return vehicle })
    lookup.resolves(vehicle)
    const saving = saveSnapshot({ receipt: first.receipt as string }, 'actor')
    await entered
    clock.tick(31000)
    const second = await preview(input, { actor: 'actor' })
    release()
    try { await saving; expect.fail('stale save must fail') } catch (error) { expect((error as Error).message).to.match(/receipt/i) }
    expect((RoutePlanModel.create as sinon.SinonStub).callCount).to.equal(0)
    await saveSnapshot({ receipt: second.receipt as string }, 'actor')
    expect((RoutePlanModel.create as sinon.SinonStub).callCount).to.equal(1)
  })

  it('saves the reviewed fields exactly without calling the provider again and rejects replay', async () => {
    const reviewed = await preview(input, { actor: 'actor' })
    const matrixCalls = (provider.computeMatrix as sinon.SinonStub).callCount
    const result = await saveSnapshot({ receipt: reviewed.receipt as string }, 'actor')
    expect(result.metrics).to.deep.equal(reviewed.metrics)
    expect(result.stops.map((stop) => [stop.clientId, stop.saleIds])).to.deep.equal(reviewed.route.stops.map((stop) => [stop.clientId, stop.saleIds]))
    expect(result.encodedPolyline).to.equal(reviewed.route.encodedPolyline)
    expect(result.depot).to.deep.equal({ name: reviewed.route.depot.name, latitude: reviewed.route.depot.latitude, longitude: reviewed.route.depot.longitude })
    expect(result.segments.map((segment) => [segment.fromStopSequence, segment.toStopSequence, segment.distanceMeters, segment.durationSeconds])).to.deep.equal([[0, 1, 10, 20], [1, 0, 11, 21]])
    expect(result.fuelAssumptions).to.deep.equal(reviewed.fuelAssumptions)
    expect(result.scheduleAssumptions).to.deep.equal(reviewed.scheduleAssumptions)
    expect(result.stopEstimates).to.deep.equal(reviewed.stopEstimates)
    expect(result.saleReferences).to.deep.equal(reviewed.saleReferences)
    expect((provider.computeMatrix as sinon.SinonStub).callCount).to.equal(matrixCalls)
    expect((provider.computeRoute as sinon.SinonStub).callCount).to.equal(1)
    try { await saveSnapshot({ receipt: reviewed.receipt as string }, 'actor'); expect.fail('expected replay rejection') } catch (error) { expect((error as Error).message).to.match(/receipt/i) }
  })

  it('rejects wrong actor, expiry, changed sale and concurrent claim', async () => {
    const reviewed = await preview(input, { actor: 'actor' })
    const receipt = { receipt: reviewed.receipt as string }
    try { await saveSnapshot(receipt, 'other'); expect.fail('expected actor rejection') } catch (error) { expect((error as Error).message).to.match(/receipt/i) }
    stored.expiresAt = new Date(0)
    try { await saveSnapshot(receipt, 'actor'); expect.fail('expected expiry rejection') } catch (error) { expect((error as Error).message).to.match(/receipt/i) }
    stored.expiresAt = new Date(Date.now() + 60000)
    sale.estado = 'Cancelado'
    try { await saveSnapshot(receipt, 'actor'); expect.fail('expected freshness rejection') } catch (error) { expect((error as Error).message).to.match(/receipt/i) }
    sale.estado = 'Creado'
    const results = await Promise.allSettled([saveSnapshot(receipt, 'actor'), saveSnapshot(receipt, 'actor')])
    expect(results.filter((result) => result.status === 'fulfilled')).to.have.length(1)
    expect(results.filter((result) => result.status === 'rejected')).to.have.length(1)
  })

  it('rejects an invalid grouped client order before any provider request', async () => {
    try {
      await preview({ ...input, clientOrder: [String(saleId)] }, { actor: 'actor' })
      expect.fail('expected invalid order rejection')
    } catch (error) {
      expect((error as Error).message).to.match(/permutation/i)
    }
    expect((provider.computeMatrix as sinon.SinonStub).callCount).to.equal(0)
    expect((provider.computeRoute as sinon.SinonStub).callCount).to.equal(0)
  })

  it('rejects changed client coordinates or routing revision at save', async () => {
    const reviewed = await preview(input, { actor: 'actor' })
    const receipt = { receipt: reviewed.receipt as string }
    client.lat = 3
    try { await saveSnapshot(receipt, 'actor'); expect.fail('expected changed client rejection') } catch (error) { expect((error as Error).message).to.match(/receipt/i) }
    client.lat = 1
    config.revision = 2
    try { await saveSnapshot(receipt, 'actor'); expect.fail('expected changed config rejection') } catch (error) { expect((error as Error).message).to.match(/receipt/i) }
    config.revision = 1
  })

  it('permits retry after an insert failure without creating two snapshots', async () => {
    const reviewed = await preview(input, { actor: 'actor' })
    const create = RoutePlanModel.create as sinon.SinonStub
    create.onFirstCall().rejects(new Error('write failed'))
    try { await saveSnapshot({ receipt: reviewed.receipt as string }, 'actor'); expect.fail('expected write failure') } catch (error) { expect((error as Error).message).to.equal('write failed') }
    await saveSnapshot({ receipt: reviewed.receipt as string }, 'actor')
    expect(create.callCount).to.equal(2)
    expect(String(create.firstCall.args[0]._id)).to.equal(String(create.secondCall.args[0]._id))
  })
})
