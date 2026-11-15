import { expect } from 'chai'
import sinon from 'sinon'
import { Types } from 'mongoose'
import ClientModel from '../src/models/client'
import DeliveryZoneModel from '../src/models/deliveryZone'
import { ClientEditConflictError, ClientInputError, ClientLocationConflictError, getClientSearch, insertClient, updateClient } from '../src/services/client'
import type { Client } from '../src/interfaces/client.interface'

describe('Client management without a database', () => {
  afterEach(() => sinon.restore())

  it('defaults only newly created clients to active and preserves an explicit inactive status', async () => {
    const create = sinon.stub(ClientModel, 'create').callsFake(async (input: unknown) => new ClientModel(input) as never)
    const legacyPayload = { nombreCompleto: 'Mobile client', address: '', telefonos: [], lat: null, lng: null }
    const active = await insertClient(legacyPayload as unknown as Client)
    const inactive = await insertClient({ nombreCompleto: 'Inactive client', isActive: false } as Client)
    expect(active.isActive).to.equal(true)
    expect(inactive.isActive).to.equal(false)
    expect(create.firstCall.args[0]).to.include({ isActive: true })
    expect(create.secondCall.args[0]).to.include({ isActive: false })
    expect(legacyPayload).not.to.have.property('isActive')
    expect(ClientModel.hydrate({ nombreCompleto: 'Existing legacy client' }).isActive).to.equal(undefined)
  })

  it('omits null addresses on creation and unsets them on update', async () => {
    const create = sinon.stub(ClientModel, 'create').callsFake(async (input: unknown) => new ClientModel(input) as never)
    await insertClient({ nombreCompleto: 'Client', address: null } as unknown as Client)
    expect(create.firstCall.args[0]).not.to.have.property('address')
    sinon.stub(ClientModel, 'findById').returns({ lean: async () => ({ address: 'Old', lat: null, lng: null, locationRevision: 1 }) } as never)
    const update = sinon.stub(ClientModel, 'updateOne').resolves({ matchedCount: 1 } as never)
    await updateClient(new Types.ObjectId(), { address: null } as unknown as Client)
    expect(update.firstCall.args[1]).to.have.nested.property('$unset.address', 1)
    expect(update.firstCall.args[1]).not.to.have.nested.property('$set.address')
  })

  it('treats search input literally and includes management fields', async () => {
    const pipeline: Array<Record<string, unknown>> = []
    const aggregate = {
      skip: sinon.stub().returnsThis(),
      limit: sinon.stub().returnsThis(),
      then: (resolve: (value: unknown[]) => void) => resolve([])
    }
    sinon.stub(ClientModel, 'aggregate').callsFake(((stages: Array<Record<string, unknown>>) => {
      pipeline.push(...stages)
      return aggregate
    }) as typeof ClientModel.aggregate)
    await getClientSearch('a.*', 25, 26)
    expect(pipeline[0]).to.deep.equal({ $match: { nombreCompleto: { $regex: 'a\\.\\*', $options: 'i' } } })
    expect(pipeline[1]).to.have.nested.property('$project.isActive', 1)
    expect(pipeline[1]).to.have.nested.property('$project.deliveryZoneId', 1)
    expect(aggregate.skip.calledOnceWithExactly(25)).to.equal(true)
    expect(aggregate.limit.calledOnceWithExactly(26)).to.equal(true)
  })

  it('rejects location changes without a reviewed snapshot', async () => {
    sinon.stub(ClientModel, 'findById').returns({ lean: async () => ({ address: 'Old', lat: 0, lng: 0, locationRevision: 1 }) } as never)
    const update = sinon.stub(ClientModel, 'updateOne')
    try {
      await updateClient(new Types.ObjectId(), { address: 'New', expectedFields: {} } as unknown as Client, true)
      expect.fail('Expected a conflict')
    } catch (error) {
      expect(error).to.be.instanceOf(ClientLocationConflictError)
    }
    expect(update.called).to.equal(false)
  })

  it('allows legacy location updates without a snapshot', async () => {
    sinon.stub(ClientModel, 'findById').returns({ lean: async () => ({ address: 'Old', lat: null, lng: null, locationRevision: 0 }) } as never)
    const update = sinon.stub(ClientModel, 'updateOne').resolves({ matchedCount: 1 } as never)
    await updateClient(new Types.ObjectId(), { address: 'New', lat: null, lng: null } as unknown as Client)
    expect(update.calledOnce).to.equal(true)
    expect(update.firstCall.args[0]).to.have.property('address', 'Old')
  })

  it('rejects a stale managed location snapshot and atomically guards accepted updates', async () => {
    sinon.stub(ClientModel, 'findById').returns({ lean: async () => ({ address: 'Old', lat: 0, lng: 0, locationRevision: 2 }) } as never)
    const update = sinon.stub(ClientModel, 'updateOne').resolves({ matchedCount: 1 } as never)
    const item = { address: null, expectedFields: {}, expectedLocation: { address: 'Old', lat: 0, lng: 0, locationRevision: 1 } }
    try {
      await updateClient(new Types.ObjectId(), item as unknown as Client, true)
      expect.fail('Expected a conflict')
    } catch (error) { expect(error).to.be.instanceOf(ClientLocationConflictError) }
    expect(update.called).to.equal(false)
    item.expectedLocation.locationRevision = 2
    await updateClient(new Types.ObjectId(), item as unknown as Client, true)
    expect(update.firstCall.args[0]).to.include({ address: 'Old', lat: 0, lng: 0, locationRevision: 2 })
    expect(update.firstCall.args[1]).to.have.nested.property('$unset.address', 1)
    expect(update.firstCall.args[1]).not.to.have.nested.property('$set.address')
  })

  it('uses atomic contact preconditions and reports a conflict instead of overwriting', async () => {
    const update = sinon.stub(ClientModel, 'updateOne').resolves({ matchedCount: 0 } as never)
    sinon.stub(ClientModel, 'findById').returns({ lean: async () => ({ nombreCompleto: 'Changed' }) } as never)
    try {
      await updateClient(new Types.ObjectId(), { nombreCompleto: 'New', expectedFields: { nombreCompleto: 'Old' } } as unknown as Client, true)
      expect.fail('Expected a conflict')
    } catch (error) {
      expect(error).to.be.instanceOf(ClientEditConflictError)
    }
    expect(update.firstCall.args[0]).to.have.property('nombreCompleto').deep.equal({ $eq: 'Old' })
  })

  it('validates only fields supplied on patch and rejects invalid create and patch inputs', async () => {
    const update = sinon.stub(ClientModel, 'updateOne').resolves({ matchedCount: 1 } as never)
    const create = sinon.stub(ClientModel, 'create')
    for (const item of [{ nombreCompleto: '  ' }, { nombreCompleto: 'A', telefonos: [-1] }, { nombreCompleto: 'A', telefonos: [1000000000000000] }, { nombreCompleto: 'A', telefonos: ['1e5'] }, { nombreCompleto: 'A', deliveryZoneId: 'bad' }]) {
      try {
        await insertClient(item as unknown as Client)
        expect.fail('Expected invalid input')
      } catch (error) { expect(error).to.be.instanceOf(ClientInputError) }
    }
    for (const item of [{ nombreCompleto: '' }, { telefonos: [1.5] }, { isActive: 'false' }, { 'telefonos.0': -1 }]) {
      try {
        await updateClient(new Types.ObjectId(), item as unknown as Client)
        expect.fail('Expected invalid input')
      } catch (error) { expect(error).to.be.instanceOf(ClientInputError) }
    }
    await updateClient(new Types.ObjectId(), { isActive: false } as Client)
    expect(create.called).to.equal(false)
    expect(update.calledOnce).to.equal(true)
  })

  it('requires a real active zone when assigning one', async () => {
    const exists = sinon.stub(DeliveryZoneModel, 'exists').resolves(null)
    const update = sinon.stub(ClientModel, 'updateOne').resolves({ matchedCount: 1 } as never)
    const zone = '507f1f77bcf86cd799439012'
    try {
      await updateClient(new Types.ObjectId(), { deliveryZoneId: zone } as unknown as Client)
      expect.fail('Expected invalid zone')
    } catch (error) { expect(error).to.be.instanceOf(ClientInputError) }
    exists.resolves({ _id: new Types.ObjectId(zone) } as never)
    await updateClient(new Types.ObjectId(), { deliveryZoneId: zone } as unknown as Client)
    expect(exists.firstCall.args[0]).to.have.property('active', true)
    expect(update.calledOnce).to.equal(true)
  })

  it('updates status without touching location', async () => {
    const update = sinon.stub(ClientModel, 'updateOne').resolves({ matchedCount: 1 } as never)
    const id = new Types.ObjectId()
    await updateClient(id, { isActive: false } as Client)
    expect(update.firstCall.args).to.deep.equal([{ _id: id }, { $set: { isActive: false } }])
  })
})
