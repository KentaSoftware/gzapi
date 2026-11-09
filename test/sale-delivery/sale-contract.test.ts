/* eslint-disable @typescript-eslint/consistent-type-assertions */
import { expect } from 'chai'
import sinon from 'sinon'
import { Types } from 'mongoose'
import SaleModel from '../../src/models/sale'
import ClientModel from '../../src/models/client'
import ItemSaleModel from '../../src/models/itemSale'
import { postItem, postMultipleItem, updateItem } from '../../src/controllers/sale'
import { saleDeliverySchema } from '../../src/schemas/routeOptimization'

describe('sale delivery creation without a database', () => {
  const clientId = new Types.ObjectId()
  const actorId = new Types.ObjectId()
  const payload = (): Record<string, unknown> => ({
    estado: 'Pendiente',
    total: 100,
    idCliente: String(clientId),
    cliente: 'Forged name',
    itemsSale: [{ _id: String(new Types.ObjectId()), cantidad: 2, total: 100, precio: 50 }]
  })
  let client: Record<string, unknown> | null
  let writes: sinon.SinonStub
  let itemWrites: sinon.SinonStub

  const invoke = async (body: unknown, batch = false): Promise<{ status: number, body: unknown }> => {
    const result = { status: 200, body: undefined as unknown }
    const res = { locals: {}, status: (status: number) => { result.status = status; return res }, send: (value: unknown) => { result.body = value; return res } }
    await (batch ? postMultipleItem : postItem)({ body, user: { id: String(actorId) } } as never, res as never)
    return result
  }

  beforeEach(() => {
    client = { _id: clientId, nombreCompleto: 'Registered Client', isActive: true }
    sinon.stub(ClientModel, 'findById').callsFake(async () => client as never)
    writes = sinon.stub(SaleModel, 'create').callsFake(async (input: unknown) => ({ ...(input as object), _id: new Types.ObjectId() }) as never)
    itemWrites = sinon.stub(ItemSaleModel, 'create').resolves({} as never)
  })
  afterEach(() => { sinon.restore() })

  it('rejects missing, malformed, unknown and inactive clients before writes', async () => {
    for (const value of [undefined, 'bad', String(clientId)]) {
      if (value === String(clientId)) client = null
      const result = await invoke({ ...payload(), idCliente: value })
      expect(result.status).to.equal(400)
    }
    client = { _id: clientId, nombreCompleto: 'Inactive', isActive: false }
    expect((await invoke(payload())).status).to.equal(400)
    expect(writes.callCount).to.equal(0)
    expect(itemWrites.callCount).to.equal(0)
  })

  it('creates a linked, server-named, pending, undated delivery', async () => {
    const result = await invoke(payload())
    expect(result.status).to.equal(200)
    const stored = writes.firstCall.args[0] as Record<string, unknown>
    expect(String(stored.idCliente)).to.equal(String(clientId))
    expect(stored.cliente).to.equal('Registered Client')
    expect(stored.delivery).to.deep.equal({ status: 'PENDING' })
    expect(itemWrites.callCount).to.equal(1)
  })

  it('rejects externally supplied delivery status, date and delivery timestamp', async () => {
    for (const delivery of [{ status: 'DELIVERED' }, { status: 'PENDING', serviceDate: '2026-11-10' }, { status: 'PENDING', deliveredAt: '2026-11-10' }]) {
      expect((await invoke({ ...payload(), delivery })).status).to.equal(400)
    }
    expect((await invoke({ ...payload(), 'delivery.status': 'DELIVERED' })).status).to.equal(400)
    expect(writes.callCount).to.equal(0)
    expect(itemWrites.callCount).to.equal(0)
  })

  it('prevalidates every batch sale and line before any write', async () => {
    for (const bad of [{ ...payload(), idCliente: 'bad' }, { ...payload(), itemsSale: [{ _id: 'bad', cantidad: 1, total: 1, precio: 1 }] }, { ...payload(), total: 'invalid' }]) {
      expect((await invoke([payload(), bad], true)).status).to.equal(400)
    }
    expect(writes.callCount).to.equal(0)
    expect(itemWrites.callCount).to.equal(0)
  })

  it('creates every valid batch sale with a pending delivery', async () => {
    expect((await invoke([payload(), payload()], true)).status).to.equal(200)
    expect(writes.callCount).to.equal(2)
    expect(itemWrites.callCount).to.equal(2)
    for (const call of writes.getCalls()) {
      expect((call.args[0] as Record<string, unknown>).delivery).to.deep.equal({ status: 'PENDING' })
    }
  })

  it('retains runtime write failures rather than reporting success', async () => {
    itemWrites.rejects(new Error('write failed'))
    expect((await invoke(payload())).status).to.equal(500)
    expect(writes.callCount).to.equal(1)
  })

  it('does not write when a client lookup fails', async () => {
    sinon.restore()
    sinon.stub(ClientModel, 'findById').rejects(new Error('lookup failed'))
    writes = sinon.stub(SaleModel, 'create')
    itemWrites = sinon.stub(ItemSaleModel, 'create')
    expect((await invoke([payload(), payload()], true)).status).to.equal(500)
    expect(writes.callCount).to.equal(0)
    expect(itemWrites.callCount).to.equal(0)
  })

  it('preserves delivery on ordinary legacy updates and rejects attempted mutation', async () => {
    const set = sinon.spy()
    sinon.stub(SaleModel, 'findById').resolves({ set, save: async () => ({}) } as never)
    const result = { status: 200 }
    const res = { locals: {}, status: (value: number) => { result.status = value; return res }, send: () => res }
    await updateItem({ params: { id: String(new Types.ObjectId()) }, body: { estado: 'Modificado', itemsSale: [] } } as never, res as never)
    expect(result.status).to.equal(200)
    expect(set.firstCall.args[0]).not.to.have.property('delivery')
    await updateItem({ params: { id: String(new Types.ObjectId()) }, body: { delivery: { status: 'DELIVERED' }, itemsSale: [] } } as never, res as never)
    expect(result.status).to.equal(400)
    expect(set.callCount).to.equal(1)
    await updateItem({ params: { id: String(new Types.ObjectId()) }, body: { 'delivery.status': 'DELIVERED', itemsSale: [] } } as never, res as never)
    expect(result.status).to.equal(400)
    expect(set.callCount).to.equal(1)
  })

  it('allows undated pending while keeping delivered timestamp validation', async () => {
    const sale = new SaleModel({ estado: 'Pendiente', total: 1, user: actorId, idCliente: clientId, delivery: { status: 'PENDING' } })
    expect(await sale.validate().then(() => null, (error: Error) => error)).to.equal(null)
    expect(saleDeliverySchema.safeParse({ status: 'PENDING' }).success).to.equal(true)
    expect(saleDeliverySchema.safeParse({ status: 'DELIVERED' }).success).to.equal(false)
    expect(saleDeliverySchema.safeParse({ status: 'PENDING', serviceDate: new Date() }).success).to.equal(true)
    expect(saleDeliverySchema.safeParse({ status: 'DELIVERED', deliveredAt: new Date() }).success).to.equal(true)
    sale.delivery = { status: 'DELIVERED' }
    expect(await sale.validate().then(() => null, (error: Error) => error)).to.be.instanceOf(Error)
  })
})
