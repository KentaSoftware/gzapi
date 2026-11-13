import { expect } from 'chai'
import sinon from 'sinon'
import { Types } from 'mongoose'
import ClientModel from '../../src/models/client'
import { confirmLocation, insertClient, updateClient } from '../../src/services/client'
import { clientLocationConfirmationSchema } from '../../src/schemas/clientGeocoding'
import { confirmLocationItem } from '../../src/controllers/client'

const stubValue = (value: unknown): never => value as never

describe('location write safety', () => {
  const expectedLocation = { address: 'Old address', lat: 1, lng: 2, locationRevision: 0 }
  afterEach(() => sinon.restore())

  it('rejects dotted and nested geocoding input before the actual mongoose model can cast it', async () => {
    const payload = { nombreCompleto: 'Test', lat: 1, lng: 2, 'geocoding.status': 'CONFIRMED', 'geocoding.source': 'MANUAL', 'geocoding.validatedAt': new Date(), 'geocoding.validatedBy': String(new Types.ObjectId()) }
    const forged = new ClientModel(payload)
    await forged.validate()
    expect(forged.geocoding?.status).to.equal('CONFIRMED')
    const create = sinon.stub(ClientModel, 'create').callsFake(async (input: unknown) => {
      const doc = new ClientModel(input)
      await doc.validate()
      return doc as never
    })
    for (const input of [payload, { nombreCompleto: 'Test', geocoding: { status: 'CONFIRMED' } }]) {
      try { await insertClient(input as never); expect.fail('Expected rejection') } catch (error) { expect((error as Error).name).to.equal('ClientLocationInputError') }
    }
    expect(create.called).to.equal(false)
  })

  it('requires reviewed state and includes it in manual and provider compare-and-set filters', async () => {
    const manual = { manualConfirmation: { lat: 4, lng: 5 }, expectedLocation }
    const provider = { candidate: { lat: 4, lng: 5, formattedAddress: 'New', placeId: 'p', precision: 'ROOFTOP' }, expectedLocation }
    expect(clientLocationConfirmationSchema.safeParse({ manualConfirmation: manual.manualConfirmation }).success).to.equal(false)
    const write = sinon.stub(ClientModel, 'findOneAndUpdate').resolves(stubValue({}))
    for (const input of [manual, provider]) {
      expect(clientLocationConfirmationSchema.safeParse(input).success).to.equal(true)
      await confirmLocation(new Types.ObjectId(), input as never, String(new Types.ObjectId()))
      expect(write.lastCall.args[0]).to.include({ address: expectedLocation.address, lat: 1, lng: 2 })
      expect(write.lastCall.args[0]).to.have.property('$or')
      expect(write.lastCall.args[1]).to.have.property('$inc').deep.equal({ locationRevision: 1 })
    }
  })

  it('reports a conflict when reviewed coordinates changed before confirmation', async () => {
    sinon.stub(ClientModel, 'findOneAndUpdate').resolves(null)
    sinon.stub(ClientModel, 'exists').resolves(stubValue({ _id: new Types.ObjectId() }))
    try {
      await confirmLocation(new Types.ObjectId(), { manualConfirmation: { lat: 4, lng: 5 }, expectedLocation }, String(new Types.ObjectId()))
      expect.fail('Expected conflict')
    } catch (error) { expect((error as Error).name).to.equal('ClientLocationConflictError') }
  })

  it('rejects an ABA confirmation after the revision advances', async () => {
    const current = { address: 'Old address', lat: 1, lng: 2, locationRevision: 2 }
    const write = sinon.stub(ClientModel, 'findOneAndUpdate').callsFake((filter: unknown) => {
      const query = filter as { locationRevision?: number, $or?: Array<{ locationRevision: unknown }> }
      const matches = query.locationRevision === current.locationRevision || query.$or?.some((entry) => entry.locationRevision === current.locationRevision) === true
      return Promise.resolve(matches ? current : null) as never
    })
    sinon.stub(ClientModel, 'exists').resolves(stubValue({ _id: new Types.ObjectId() }))
    try {
      await confirmLocation(new Types.ObjectId(), { manualConfirmation: { lat: 4, lng: 5 }, expectedLocation }, String(new Types.ObjectId()))
      expect.fail('Expected conflict')
    } catch (error) { expect((error as Error).name).to.equal('ClientLocationConflictError') }
    expect(write.calledOnce).to.equal(true)
  })

  it('returns HTTP 409 for stale manual and provider confirmations without a server', async () => {
    sinon.stub(ClientModel, 'findOneAndUpdate').resolves(null)
    sinon.stub(ClientModel, 'exists').resolves(stubValue({ _id: new Types.ObjectId() }))
    for (const body of [
      { manualConfirmation: { lat: 4, lng: 5 }, expectedLocation },
      { candidate: { lat: 4, lng: 5, formattedAddress: 'New', placeId: 'p', precision: 'ROOFTOP' }, expectedLocation }
    ]) {
      let status = 200
      let responseBody: unknown
      const req = { params: { id: String(new Types.ObjectId()) }, body }
      const res = { locals: { userId: String(new Types.ObjectId()) }, status: (value: number) => { status = value }, send: (value: unknown) => { responseBody = value } }
      await confirmLocationItem(req as never, res as never)
      expect(status).to.equal(409)
      expect(responseBody).to.include({ code: 'CLIENT_LOCATION_CONFLICT' })
    }
  })

  it('retains confirmation for unchanged full-form coordinates and detects concurrent changes', async () => {
    const current = { ...expectedLocation, geocoding: { status: 'CONFIRMED', source: 'MANUAL', validatedBy: new Types.ObjectId(), validatedAt: new Date() } }
    sinon.stub(ClientModel, 'findById').returns(stubValue({ lean: async () => current }))
    const write = sinon.stub(ClientModel, 'updateOne').resolves(stubValue({ matchedCount: 1 }))
    await updateClient(new Types.ObjectId(), stubValue({ ...expectedLocation, nombreCompleto: 'Name' }))
    expect(write.firstCall.args[1]).not.to.have.property('$unset')
    expect(write.firstCall.args[0]).to.have.property('$or')
    const filter = write.firstCall.args[0]
    const query = ClientModel.find(filter)
    query.cast(ClientModel)
    expect(query.getFilter().geocoding).to.include({ status: 'CONFIRMED', source: 'MANUAL' })
    write.resolves(stubValue({ matchedCount: 0 }))
    try { await updateClient(new Types.ObjectId(), stubValue({ ...expectedLocation })); expect.fail('Expected conflict') } catch (error) { expect((error as Error).name).to.equal('ClientLocationConflictError') }
  })

  it('rejects a stale reviewed form but accepts legacy location edits with atomic invalidation', async () => {
    sinon.stub(ClientModel, 'findById').returns(stubValue({ lean: async () => expectedLocation }))
    const write = sinon.stub(ClientModel, 'updateOne').resolves(stubValue({ matchedCount: 1 }))
    for (const item of [{ lat: 9, expectedLocation: { address: 'Older', lat: 0, lng: 0, locationRevision: 0 } }]) {
      try { await updateClient(new Types.ObjectId(), item as never); expect.fail('Expected conflict') } catch (error) { expect((error as Error).name).to.equal('ClientLocationConflictError') }
    }
    expect(write.called).to.equal(false)
    await updateClient(new Types.ObjectId(), stubValue({ lat: 9 }))
    expect(write.firstCall.args[1]).to.have.property('$unset')
    expect(write.firstCall.args[1]).to.have.property('$inc').deep.equal({ locationRevision: 1 })
    expect(write.firstCall.args[0]).to.have.property('$or')
  })

  it('accepts legacy provider and manual references but requires a snapshot for manual confirmation', async () => {
    const candidate = { lat: 4, lng: 5, formattedAddress: 'New', placeId: 'p', precision: 'ROOFTOP' }
    const write = sinon.stub(ClientModel, 'findOneAndUpdate').resolves(stubValue({}))
    for (const input of [{ candidate }, { manualReference: { address: 'Reference' } }]) {
      const parsed = clientLocationConfirmationSchema.safeParse(input)
      expect(parsed.success).to.equal(true)
      if (!parsed.success) throw new Error('Invalid fixture')
      await confirmLocation(new Types.ObjectId(), parsed.data, String(new Types.ObjectId()))
      expect(write.lastCall.args[0]).to.have.keys('_id')
      expect(write.lastCall.args[1]).to.have.property('$inc').deep.equal({ locationRevision: 1 })
    }
    expect(clientLocationConfirmationSchema.safeParse({ manualConfirmation: { lat: 4, lng: 5 } }).success).to.equal(false)
  })

  it('returns a conflict if a legacy location edit races another write', async () => {
    sinon.stub(ClientModel, 'findById').returns(stubValue({ lean: async () => expectedLocation }))
    const write = sinon.stub(ClientModel, 'updateOne').resolves(stubValue({ matchedCount: 0 }))
    try {
      await updateClient(new Types.ObjectId(), stubValue({ lat: 9 }))
      expect.fail('Expected conflict')
    } catch (error) { expect((error as Error).name).to.equal('ClientLocationConflictError') }
    expect(write.firstCall.args[1]).to.have.property('$inc').deep.equal({ locationRevision: 1 })
    expect(write.firstCall.args[1]).to.have.property('$unset').deep.equal({ geocoding: 1 })
  })
})
