import { expect } from 'chai'
import mongoose, { Types } from 'mongoose'
import request from 'supertest'

import VehicleModel from '../../src/models/vehicle'
import RoleModel from '../../src/models/role'
import UserModel from '../../src/models/user'
import { generateToken } from '../../src/utils/jwt.handle'

const TEST_DB_URI = 'mongodb://localhost:27017/gzapi_route_plan_assignment_options_test'

describe('Route assignment options API', () => {
  let app: Awaited<ReturnType<typeof import('../../src/app').createApp>>
  let token: string
  let readerId: Types.ObjectId

  before(async () => {
    await mongoose.connect(TEST_DB_URI)
    const { createApp } = await import('../../src/app')
    app = await createApp()
  })

  after(async () => {
    const dbName = mongoose.connection.db?.databaseName
    if (dbName?.endsWith('_test') === true) await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
  })

  beforeEach(async () => {
    await Promise.all([RoleModel.deleteMany({}), UserModel.deleteMany({}), VehicleModel.deleteMany({})])
    const role = await RoleModel.create({ name: 'Assignment options reader', permissions: ['read_route_plan'] })
    const reader = await UserModel.create({ nickname: 'assignment-options-reader', password: 'not-a-real-password', role: role._id, isActive: true })
    readerId = reader._id
    token = await generateToken(reader)
  })

  it('S-06: returns assignment options behind authentication and read_route_plan', async () => {
    const unauthenticated = await request(app).get('/routePlan/assignment-options')
    expect(unauthenticated.status).to.equal(401)

    const response = await request(app)
      .get('/routePlan/assignment-options')
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).to.equal(200)
    expect(response.body).to.have.keys(['drivers', 'vehicles'])
  })

  it('TC-017: includes users from getAllUsers without role filtering and preserves inactive users', async () => {
    const activeUser = await UserModel.create({ nickname: 'route-driver', password: 'not-a-real-password', isActive: true })
    const inactiveUser = await UserModel.create({ nickname: 'inactive-route-driver', password: 'not-a-real-password', isActive: false })

    const response = await request(app)
      .get('/routePlan/assignment-options')
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).to.equal(200)
    expect(response.body.drivers).to.deep.include.members([
      { id: String(activeUser._id), nickname: 'route-driver', isActive: true },
      { id: String(inactiveUser._id), nickname: 'inactive-route-driver', isActive: false }
    ])
    expect(response.body.drivers).to.have.length(3)
  })

  it('TC-018: returns selectable vehicle identity and availability fields', async () => {
    await VehicleModel.create({ code: 'AA123AA', fuelConsumptionLitersPer100Km: 12.5, attributes: { type: 'van' }, active: true })
    await VehicleModel.create({ code: 'BB456BB', fuelConsumptionLitersPer100Km: 8, attributes: {}, active: false })

    const response = await request(app)
      .get('/routePlan/assignment-options')
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).to.equal(200)
    expect(response.body.vehicles).to.deep.equal([{
      id: response.body.vehicles[0].id,
      code: 'AA123AA',
      fuelConsumptionLitersPer100Km: 12.5,
      attributes: { type: 'van' },
      availability: true
    }])
  })

  it('TC-019: does not mutate users or vehicles while reading options', async () => {
    await VehicleModel.create({ code: 'CC789CC', fuelConsumptionLitersPer100Km: 10, attributes: {}, active: true })
    const userBefore = JSON.stringify(await UserModel.findById(readerId).lean())
    const vehicleBefore = JSON.stringify(await VehicleModel.findOne({ code: 'CC789CC' }).lean())

    const response = await request(app)
      .get('/routePlan/assignment-options')
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).to.equal(200)
    expect(JSON.stringify(await UserModel.findById(readerId).lean())).to.equal(userBefore)
    expect(JSON.stringify(await VehicleModel.findOne({ code: 'CC789CC' }).lean())).to.equal(vehicleBefore)
  })
})
