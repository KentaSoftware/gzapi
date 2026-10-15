import { expect } from 'chai'
import sinon from 'sinon'
import mongoose from 'mongoose'
import request from 'supertest'

import SaleModel from '../../src/models/sale'
import CommercialFactModel from '../../src/models/commercialFact'
import RoleModel from '../../src/models/role'
import UserModel from '../../src/models/user'
import { stockPortAdapter } from '../../src/services/commercialPorts'
import { generateToken } from '../../src/utils/jwt.handle'

const TEST_DB_URI = 'mongodb://localhost:27017/gzapi_phase0_sale_foundation_test'

describe('Phase 0 — sale foundation contract', () => {
  let app: Awaited<ReturnType<typeof import('../../src/app').createApp>>
  let user: any
  let token: string

  const saleBody = (): Record<string, unknown> => ({
    estado: 'Pendiente',
    total: 100,
    cliente: 'Test Client',
    itemsSale: [
      { _id: String(new mongoose.Types.ObjectId()), total: 100, cantidad: 3, precio: 33.33 }
    ]
  })

  before(async () => {
    process.env.PHASE_0_CONTRACTS_ENABLED = 'true'
    await mongoose.connect(TEST_DB_URI)
    const { createApp } = await import('../../src/app')
    app = await createApp()
  })

  after(async () => {
    const dbName = mongoose.connection.db?.databaseName
    if (dbName?.endsWith('_test') === true) {
      await mongoose.connection.dropDatabase()
    }
    await mongoose.disconnect()
    delete process.env.PHASE_0_CONTRACTS_ENABLED
  })

  beforeEach(async () => {
    process.env.PHASE_0_CONTRACTS_ENABLED = 'true'
    await CommercialFactModel.deleteMany({})
    await SaleModel.deleteMany({})
    await UserModel.deleteMany({})
    await RoleModel.deleteMany({})

    const role = await RoleModel.create({
      name: 'Preventista',
      permissions: ['create_sale'],
      isActive: true
    })
    user = await UserModel.create({
      nickname: 'sale-contract-user',
      password: 'not-a-real-password',
      role: role._id,
      isActive: true
    })
    token = await generateToken(user)
  })

  afterEach(() => {
    sinon.restore()
  })

  it('S-32: postItem commits stock without cash inflow', async () => {
    const commitSaleSpy = sinon.stub(stockPortAdapter, 'commitSale').resolves()

    const res = await request(app)
      .post('/sale')
      .set('Authorization', `Bearer ${token}`)
      .send(saleBody())

    expect(res.status).to.equal(200)
    expect(commitSaleSpy.calledOnce).to.equal(true)

    const commitment = commitSaleSpy.firstCall.args[0]
    expect(commitment.saleId).to.equal(String(res.body._id))
    expect(commitment.actorId).to.equal(String(user._id))
    expect(commitment.lines).to.be.an('array').with.length(1)

    const stored = await SaleModel.findById(res.body._id).lean()
    expect(stored.paidAt).to.equal(undefined)

    const paymentCount = await CommercialFactModel.countDocuments({ type: 'SALE_PAYMENT', aggregateId: String(res.body._id) })
    expect(paymentCount).to.equal(0)
  })

  it('S-32 flag off: postItem does not call commitSale', async () => {
    const commitSaleSpy = sinon.stub(stockPortAdapter, 'commitSale').resolves()

    process.env.PHASE_0_CONTRACTS_ENABLED = 'false'
    let res
    try {
      res = await request(app)
        .post('/sale')
        .set('Authorization', `Bearer ${token}`)
        .send(saleBody())
    } finally {
      process.env.PHASE_0_CONTRACTS_ENABLED = 'true'
    }

    expect(res.status).to.equal(200)
    expect(commitSaleSpy.called).to.equal(false)

    const stored = await SaleModel.findById(res.body._id).lean()
    expect(stored.paidAt).to.equal(undefined)
  })
})
