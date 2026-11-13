import { expect } from 'chai'
import { clientLocationConfirmationSchema } from '../../src/schemas/clientGeocoding'
import sinon from 'sinon'
import mongoose, { Types } from 'mongoose'
import ClientModel from '../../src/models/client'
import UserModel from '../../src/models/user'
import RoleModel from '../../src/models/role'
import { confirmLocation, insertClient, updateClient } from '../../src/services/client'
import { router } from '../../src/routes/client'

const stubValue = (value: unknown): never => value as never

describe('manual coordinate confirmation input', () => {
  const expectedLocation = { address: null, lat: null, lng: null, locationRevision: 0 }
  it('accepts explicit coordinates without an address and rejects invalid coordinates', () => {
    expect(clientLocationConfirmationSchema.safeParse({ manualConfirmation: { lat: 0, lng: 0 }, expectedLocation }).success).to.equal(true)
    for (const value of [{ lat: 91, lng: 0 }, { lat: 0 }, { lat: 0, lng: 181 }, { lat: '0', lng: 0 }]) {
      expect(clientLocationConfirmationSchema.safeParse({ manualConfirmation: value, expectedLocation }).success).to.equal(false)
    }
    expect(clientLocationConfirmationSchema.safeParse({ manualReference: { address: 'Reference', lat: 0, lng: 0 }, expectedLocation }).success).to.equal(true)
  })

  afterEach(() => { sinon.restore() })

  it('atomically writes manual provenance and audit without inventing a place or address', async () => {
    const id = new Types.ObjectId()
    const actor = new Types.ObjectId()
    const write = sinon.stub(ClientModel, 'findOneAndUpdate').resolves(stubValue({ _id: id }))
    await confirmLocation(id, { manualConfirmation: { lat: -34, lng: -58 }, expectedLocation }, String(actor))
    const update = write.firstCall.args[1] as { $set: Record<string, unknown> }
    expect(update.$set).to.include({ lat: -34, lng: -58 })
    expect(update.$set).not.to.have.property('address')
    expect(update.$set.geocoding).to.include({ status: 'CONFIRMED', source: 'MANUAL' })
    expect(update.$set.geocoding).not.to.have.property('placeId')
    expect((update.$set.geocoding as { validatedBy: Types.ObjectId }).validatedBy.toString()).to.equal(String(actor))
    expect((update.$set.geocoding as { validatedAt: Date }).validatedAt).to.be.instanceOf(Date)
  })

  it('invalidates confirmation atomically when ordinary edits change coordinates', async () => {
    sinon.stub(ClientModel, 'findById').returns(stubValue({ lean: async () => ({ lat: 0, lng: 0 }) }))
    const write = sinon.stub(ClientModel, 'updateOne').resolves(stubValue({ matchedCount: 1 }))
    await updateClient(new Types.ObjectId(), stubValue({ lat: 1, lng: 2, expectedLocation: { address: null, lat: 0, lng: 0, locationRevision: 0 } }))
    const update = write.firstCall.args[1] as { $unset: Record<string, unknown> }
    expect(update.$unset).to.have.property('geocoding')
  })

  it('prevents ordinary create and update from setting confirmation metadata', async () => {
    const create = sinon.stub(ClientModel, 'create').resolves(stubValue({}))
    const update = sinon.stub(ClientModel, 'updateOne').resolves(stubValue({}))
    try { await insertClient(stubValue({ nombreCompleto: 'Client', geocoding: { status: 'CONFIRMED' } })); expect.fail('Expected rejection') } catch (error) { expect((error as Error).name).to.equal('ClientLocationInputError') }
    await updateClient(new Types.ObjectId(), stubValue({ nombreCompleto: 'Client', geocoding: { status: 'CONFIRMED' }, 'geocoding.status': 'CONFIRMED' }))
    expect(create.called).to.equal(false)
    const fields = (update.firstCall.args[1] as { $set: Record<string, unknown> }).$set
    expect(fields).not.to.have.property('geocoding')
    expect(fields).not.to.have.property('geocoding.status')
  })

  it('keeps legacy manual references pending and removes absent coordinates', async () => {
    const write = sinon.stub(ClientModel, 'findOneAndUpdate').resolves(stubValue({}))
    await confirmLocation(new Types.ObjectId(), { manualReference: { address: 'Reference' }, expectedLocation }, String(new Types.ObjectId()))
    const update = write.firstCall.args[1] as { $set: { geocoding: Record<string, unknown> }, $unset: Record<string, unknown> }
    expect(update.$set.geocoding).to.include({ status: 'PENDING', source: 'MANUAL' })
    expect(update.$set.geocoding).not.to.have.property('validatedAt')
    expect(update.$unset).to.have.keys('lat', 'lng')
  })

  it('enforces the confirmation grant on the actual route middleware without a server', async () => {
    const previousState = mongoose.connection.readyState
    mongoose.connection.readyState = 1
    try {
      const user = { isActive: true, role: new Types.ObjectId() }
      const role = { isActive: true, name: 'Editor', permissions: ['update_client'] }
      const query = (value: unknown): unknown => ({ maxTimeMS: () => ({ lean: async () => value }) })
      sinon.stub(UserModel, 'findById').callsFake(() => query(user) as never)
      sinon.stub(RoleModel, 'findById').callsFake(() => query(role) as never)
      const layers = router.stack as unknown as Array<{ route?: { path: string, stack: Array<{ handle: Function }> } }>
      const permission = layers.find((layer) => layer.route?.path === '/:id/location-confirmation')?.route?.stack[1].handle
      expect(permission).to.be.a('function')
      const invoke = async (): Promise<number> => await new Promise((resolve) => {
        let status = 200
        const response = { locals: {}, status: (value: number) => { status = value }, send: () => resolve(status) }
        permission?.({ user: { id: String(new Types.ObjectId()) } }, response, () => resolve(200))
      })
      expect(await invoke()).to.equal(403)
      role.permissions = ['confirm_client_location']
      expect(await invoke()).to.equal(200)
    } finally { mongoose.connection.readyState = previousState }
  })
})
