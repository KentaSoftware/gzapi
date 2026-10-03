const { expect } = require('chai')
const sinon = require('sinon')
const mongoose = require('mongoose')

const SaleModel = require('../../src/models/sale').default
const CommercialFactModel = require('../../src/models/commercialFact').default
const RoleModel = require('../../src/models/role').default
const UserModel = require('../../src/models/user').default
const { stockPortAdapter } = require('../../src/services/commercialPorts')
const { generateToken } = require('../../src/utils/jwt.handle')

const request = require('supertest')

const TEST_DB_URI = 'mongodb://localhost:27017/gzapi_phase0_sale_foundation_test'

describe('Phase 0 — sale foundation contract', () => {
  let app
  let user
  let token

  const saleBody = () => ({
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
    const { createApp } = require('../../src/app')
    app = await createApp()
  })

  after(async () => {
    const dbName = mongoose.connection.db && mongoose.connection.db.databaseName
    if (dbName && dbName.endsWith('_test')) {
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
    const commitSaleSpy = sinon.spy(stockPortAdapter, 'commitSale')

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
    const commitSaleSpy = sinon.spy(stockPortAdapter, 'commitSale')

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
