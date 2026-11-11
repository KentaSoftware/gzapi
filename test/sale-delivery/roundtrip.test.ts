/* eslint-disable @typescript-eslint/consistent-type-assertions */
import { expect } from 'chai'
import sinon from 'sinon'
import { Types } from 'mongoose'
import SaleModel from '../../src/models/sale'
import { SaleInputError, updateSale } from '../../src/services/sale'

describe('sale delivery update round trips', () => {
  const id = new Types.ObjectId()
  afterEach(() => { sinon.restore() })

  const fixture = (delivery: unknown): { set: sinon.SinonSpy, save: sinon.SinonStub } => {
    const document = new SaleModel({ estado: 'Pendiente', total: 10, user: new Types.ObjectId(), idCliente: new Types.ObjectId(), delivery })
    const set = sinon.spy(document, 'set')
    const save = sinon.stub(document, 'save').resolves(document)
    sinon.stub(SaleModel, 'findById').resolves(document)
    return { set, save }
  }

  for (const delivery of [
    { status: 'PENDING' },
    { status: 'PENDING', serviceDate: new Date('2026-11-10T12:30:00.000Z'), notes: 'Historical' },
    { status: 'DELIVERED', deliveredAt: new Date('2026-11-11T14:00:00.000Z'), notes: 'Done' }
  ]) {
    it(`accepts unchanged ${delivery.status} delivery and never assigns it`, async () => {
      const { set, save } = fixture(delivery)
      const roundTrip = JSON.parse(JSON.stringify(delivery)) as typeof delivery
      await updateSale(id, { estado: 'Modificado', delivery: roundTrip })
      expect(save.calledOnce).to.equal(true)
      expect(set.firstCall.args[0]).not.to.have.property('delivery')
    })
  }

  it('rejects every delivery mutation, unknown fields and dotted or operator assignments', async () => {
    const original = { status: 'DELIVERED', serviceDate: new Date('2026-11-10T12:30:00.000Z'), deliveredAt: new Date('2026-11-11T14:00:00.000Z'), notes: 'Done' }
    const { set, save } = fixture(original)
    const payloads: unknown[] = [
      { ...original, status: 'PENDING' }, { ...original, serviceDate: '2026-11-10T12:30:00.001Z' },
      { ...original, deliveredAt: null }, { ...original, notes: 'Changed' }, { ...original, extra: true },
      { status: 'DELIVERED' }, {}, null, { ...original, notes: null }
    ]
    for (const delivery of payloads) {
      try {
        await updateSale(id, { delivery } as never)
        expect.fail('Expected delivery mutation rejection')
      } catch (error) { expect(error).to.be.instanceOf(SaleInputError) }
    }
    for (const payload of [{ 'delivery.status': 'PENDING' }, { $set: { 'delivery.status': 'PENDING' } }]) {
      try {
        await updateSale(id, payload as never)
        expect.fail('Expected delivery mutation rejection')
      } catch (error) { expect(error).to.be.instanceOf(SaleInputError) }
    }
    expect(set.callCount).to.equal(0)
    expect(save.callCount).to.equal(0)
  })

  it('preserves absent delivery and distinguishes it from null or empty objects', async () => {
    const { set, save } = fixture(undefined)
    await updateSale(id, { estado: 'Modificado' })
    for (const delivery of [null, {}, { status: 'PENDING' }]) {
      try {
        await updateSale(id, { delivery } as never)
        expect.fail('Expected delivery mutation rejection')
      } catch (error) { expect(error).to.be.instanceOf(SaleInputError) }
    }
    expect(set.callCount).to.equal(1)
    expect(save.callCount).to.equal(1)
  })

  it('allows a stored null delivery to round trip without assignment', async () => {
    const { set, save } = fixture(null)
    await updateSale(id, { delivery: null } as never)
    expect(set.firstCall.args[0]).not.to.have.property('delivery')
    expect(save.calledOnce).to.equal(true)
  })
})
