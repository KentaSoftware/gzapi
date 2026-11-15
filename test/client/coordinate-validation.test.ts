import { expect } from 'chai'
import { Types } from 'mongoose'
import sinon from 'sinon'
import ClientModel from '../../src/models/client'
import { ClientInputError, ClientLocationConflictError, insertClient, updateClient } from '../../src/services/client'

const stubValue = (value: unknown): never => value as never
const id = new Types.ObjectId()

describe('client coordinate validation without database access', () => {
  afterEach(() => sinon.restore())

  it('validates creation before saving and allows missing, null, zero and boundary pairs', async () => {
    const create = sinon.stub(ClientModel, 'create').callsFake(async (input: unknown) => {
      const client = new ClientModel(input)
      await client.validate()
      return stubValue(client)
    })
    for (const pair of [{}, { lat: null, lng: null }, { lat: 0, lng: 0 }, { lat: -90, lng: 180 }, { lat: 90, lng: -180 }]) {
      await insertClient(stubValue({ nombreCompleto: 'Client', ...pair }))
    }
    expect(create.callCount).to.equal(5)
    for (const pair of [
      { lat: 1 }, { lng: 1 }, { lat: null, lng: 1 }, { lat: 1, lng: null },
      { lat: 90.01, lng: 0 }, { lat: -90.01, lng: 0 }, { lat: 0, lng: 180.01 }, { lat: 0, lng: -180.01 },
      { lat: '0', lng: 0 }, { lat: {}, lng: 0 }, { lat: NaN, lng: 0 }, { lat: 0, lng: Infinity },
      { 'lat.value': 0 }
    ]) {
      try {
        await insertClient(stubValue({ nombreCompleto: 'Client', ...pair }))
        expect.fail('Expected invalid coordinates')
      } catch (error) { expect(error).to.be.instanceOf(ClientInputError) }
    }
    expect(create.callCount).to.equal(5)
  })

  for (const managed of [false, true]) {
    it(`validates the final pair for ${managed ? 'managed' : 'legacy'} updates`, async () => {
      const current = { address: 'Old', lat: 10, lng: 20, locationRevision: 3 }
      sinon.stub(ClientModel, 'findById').returns(stubValue({ lean: async () => current }))
      const write = sinon.stub(ClientModel, 'updateOne').resolves(stubValue({ matchedCount: 1 }))
      const guard = managed ? { expectedFields: {}, expectedLocation: current } : {}
      for (const pair of [
        { lat: 91 }, { lng: 181 }, { lat: null }, { lng: null },
        { lat: '10' }, { lng: {} }, { lat: NaN }, { lng: Infinity },
        { lat: null, lng: 10 }, { lat: 10, lng: null }, { 'lng.value': 1 }
      ]) {
        try {
          await updateClient(id, stubValue({ ...pair, ...guard }), managed)
          expect.fail('Expected invalid coordinates')
        } catch (error) { expect(error).to.be.instanceOf(ClientInputError) }
      }
      expect(write.called).to.equal(false)
      for (const pair of [{ lat: -90 }, { lng: 180 }, { lat: 0, lng: 0 }, { lat: null, lng: null }]) {
        await updateClient(id, stubValue({ ...pair, ...guard }), managed)
        expect(write.lastCall.args[0]).to.include({ address: 'Old', lat: 10, lng: 20, locationRevision: 3 })
        expect(write.lastCall.args[1]).to.have.property('$inc').deep.equal({ locationRevision: 1 })
        expect(write.lastCall.args[1]).to.have.property('$unset').deep.equal({ geocoding: 1 })
        expect(write.lastCall.args[2]).to.deep.equal({ runValidators: true })
      }
      expect(write.callCount).to.equal(4)
    })
  }

  it('accepts legacy missing coordinates and rejects a partial pair unless it repairs the missing coordinate', async () => {
    const current = { address: 'Old', locationRevision: 0 }
    const find = sinon.stub(ClientModel, 'findById').returns(stubValue({ lean: async () => current }))
    const write = sinon.stub(ClientModel, 'updateOne').resolves(stubValue({ matchedCount: 1 }))
    await updateClient(id, stubValue({ address: 'New' }))
    await updateClient(id, stubValue({ lat: null, lng: null }))
    try {
      await updateClient(id, stubValue({ lat: 1 }))
      expect.fail('Expected invalid coordinates')
    } catch (error) { expect(error).to.be.instanceOf(ClientInputError) }
    find.returns(stubValue({ lean: async () => ({ address: 'Old', lat: 1, locationRevision: 0 }) }))
    await updateClient(id, stubValue({ lng: 2 }))
    expect(write.callCount).to.equal(3)
  })

  it('rejects concurrent location changes after validating a partial update', async () => {
    sinon.stub(ClientModel, 'findById').returns(stubValue({ lean: async () => ({ lat: 1, lng: 2, address: 'Old', locationRevision: 4 }) }))
    const write = sinon.stub(ClientModel, 'updateOne').resolves(stubValue({ matchedCount: 0 }))
    for (const managed of [false, true]) {
      const guard = managed ? { expectedFields: {}, expectedLocation: { lat: 1, lng: 2, address: 'Old', locationRevision: 4 } } : {}
      try {
        await updateClient(id, stubValue({ lat: 3, ...guard }), managed)
        expect.fail('Expected a conflict')
      } catch (error) { expect(error).to.be.instanceOf(ClientLocationConflictError) }
      expect(write.lastCall.args[0]).to.include({ lat: 1, lng: 2, address: 'Old', locationRevision: 4 })
    }
  })

  it('does not treat null coordinates as a confirmed location in model validation', async () => {
    const client = new ClientModel({
      nombreCompleto: 'Client',
      lat: null,
      lng: null,
      geocoding: { status: 'CONFIRMED', source: 'MANUAL', validatedAt: new Date(), validatedBy: id }
    })
    try {
      await client.validate()
      expect.fail('Expected invalid confirmation')
    } catch (error) { expect(error).to.have.property('name', 'ValidationError') }
  })
})
