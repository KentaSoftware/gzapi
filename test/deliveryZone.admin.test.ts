import { expect } from 'chai'
import mongoose, { Types } from 'mongoose'
import request from 'supertest'

import DeliveryZoneModel from '../src/models/deliveryZone'
import RoleModel from '../src/models/role'
import UserModel from '../src/models/user'
import { generateToken } from '../src/utils/jwt.handle'

const TEST_DB_URI = 'mongodb://localhost:27017/gzapi_delivery_zone_admin_test'

describe('Delivery zone administration', () => {
  let app: Awaited<ReturnType<typeof import('../src/app').createApp>>
  let readToken: string
  let manageToken: string
  let unrelatedToken: string

  before(async () => {
    await mongoose.connect(TEST_DB_URI)
    const { createApp } = await import('../src/app')
    app = await createApp()
  })

  after(async () => {
    const dbName = mongoose.connection.db?.databaseName
    if (dbName?.endsWith('_test') === true) await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
  })

  beforeEach(async () => {
    await Promise.all([
      DeliveryZoneModel.deleteMany({}),
      UserModel.deleteMany({}),
      RoleModel.deleteMany({})
    ])

    const readRole = await RoleModel.create({ name: 'Zone reader', permissions: ['read_route_plan'] })
    const manageRole = await RoleModel.create({ name: 'Zone manager', permissions: ['manage_delivery_zone', 'read_route_plan'] })
    const unrelatedRole = await RoleModel.create({ name: 'Sales reader', permissions: ['read_sale'] })
    const readUser = await UserModel.create({ nickname: 'zone-reader', password: 'not-a-real-password', role: readRole._id })
    const manageUser = await UserModel.create({ nickname: 'zone-manager', password: 'not-a-real-password', role: manageRole._id })
    const unrelatedUser = await UserModel.create({ nickname: 'sales-reader', password: 'not-a-real-password', role: unrelatedRole._id })

    readToken = await generateToken(readUser)
    manageToken = await generateToken(manageUser)
    unrelatedToken = await generateToken(unrelatedUser)
  })

  const createZone = (overrides: Record<string, unknown> = {}): request.Test => request(app)
    .post('/deliveryZone')
    .set('Authorization', `Bearer ${manageToken}`)
    .send({ code: 'NORTE', name: 'Norte', ...overrides })

  const patchZone = (id: string, body: Record<string, unknown>): request.Test => request(app)
    .patch(`/deliveryZone/${id}`)
    .set('Authorization', `Bearer ${manageToken}`)
    .send(body)

  it('S-27: requires authentication and permissions for zone reads and writes', async () => {
    const unauthList = await request(app).get('/deliveryZone')
    const forbiddenList = await request(app).get('/deliveryZone').set('Authorization', `Bearer ${unrelatedToken}`)
    const unauthCreate = await request(app).post('/deliveryZone').send({ code: 'NORTE', name: 'Norte' })
    const forbiddenCreate = await request(app).post('/deliveryZone').set('Authorization', `Bearer ${readToken}`).send({ code: 'NORTE', name: 'Norte' })
    const unauthUpdate = await request(app).patch(`/deliveryZone/${new Types.ObjectId().toString()}`).send({ active: false })
    const forbiddenUpdate = await request(app).patch(`/deliveryZone/${new Types.ObjectId().toString()}`).set('Authorization', `Bearer ${readToken}`).send({ active: false })

    expect(unauthList.status).to.equal(401)
    expect(forbiddenList.status).to.equal(403)
    expect(unauthCreate.status).to.equal(401)
    expect(forbiddenCreate.status).to.equal(403)
    expect(unauthUpdate.status).to.equal(401)
    expect(forbiddenUpdate.status).to.equal(403)
    expect(await DeliveryZoneModel.countDocuments({})).to.equal(0)
  })

  it('S-27: creates a zone with stable identity, normalized name and active flag', async () => {
    const response = await createZone({ code: ' norte ', name: '  Norte  ' })

    expect(response.status).to.equal(201)
    expect(response.body.code).to.equal('NORTE')
    expect(response.body.normalizedName).to.equal('norte')
    expect(response.body.name).to.equal('Norte')
    expect(response.body.active).to.equal(true)
  })

  it('S-27: rejects a duplicate stable code without changing the catalog', async () => {
    await DeliveryZoneModel.create({ code: 'NORTE', normalizedName: 'norte', name: 'Norte', active: true })
    const before = await DeliveryZoneModel.find({}).sort({ code: 1 }).lean()

    const response = await createZone({ code: 'norte', name: 'Norte distinto' })

    expect(response.status).to.equal(409)
    expect(response.body.code).to.equal('DUPLICATE_DELIVERY_ZONE_CODE')
    expect(await DeliveryZoneModel.find({}).sort({ code: 1 }).lean()).to.deep.equal(before)
  })

  it('S-27: rejects a duplicate normalized name without changing the catalog', async () => {
    await DeliveryZoneModel.create({ code: 'CENTRO', normalizedName: 'norte', name: 'Norte', active: true })
    const before = await DeliveryZoneModel.find({}).sort({ code: 1 }).lean()

    const response = await createZone({ code: 'NORTE', name: ' norte ' })

    expect(response.status).to.equal(409)
    expect(response.body.code).to.equal('DUPLICATE_DELIVERY_ZONE_NAME')
    expect(await DeliveryZoneModel.find({}).sort({ code: 1 }).lean()).to.deep.equal(before)
  })

  it('S-27: rejects invalid zone input', async () => {
    const missingCode = await createZone({ code: undefined })
    const missingName = await createZone({ name: undefined })
    const blankName = await createZone({ name: '   ' })
    const malformedCode = await createZone({ code: 'NORTE ZONA' })

    for (const response of [missingCode, missingName, blankName, malformedCode]) {
      expect(response.status).to.equal(400)
      expect(response.body.code).to.equal('INVALID_ROUTE_INPUT')
    }
    expect(await DeliveryZoneModel.countDocuments({})).to.equal(0)
  })

  it('S-27: lists zones for authorized readers with an optional active filter', async () => {
    await DeliveryZoneModel.create({ code: 'NORTE', normalizedName: 'norte', name: 'Norte', active: true })
    await DeliveryZoneModel.create({ code: 'SUR', normalizedName: 'sur', name: 'Sur', active: false })

    const all = await request(app).get('/deliveryZone').set('Authorization', `Bearer ${readToken}`)
    const inactive = await request(app).get('/deliveryZone?active=false').set('Authorization', `Bearer ${readToken}`)

    expect(all.status).to.equal(200)
    expect(all.body.map((zone: { code: string }) => zone.code)).to.deep.equal(['NORTE', 'SUR'])
    expect(inactive.status).to.equal(200)
    expect(inactive.body.map((zone: { code: string }) => zone.code)).to.deep.equal(['SUR'])
  })

  it('S-27: updates the name and active flag while preserving the stable code', async () => {
    const zone = await DeliveryZoneModel.create({ code: 'NORTE', normalizedName: 'norte', name: 'Norte', active: true })

    const response = await patchZone(String(zone._id), { name: 'Norte Ampliado', active: false })

    expect(response.status).to.equal(200)
    expect(response.body.code).to.equal('NORTE')
    expect(response.body.name).to.equal('Norte Ampliado')
    expect(response.body.normalizedName).to.equal('norte ampliado')
    expect(response.body.active).to.equal(false)
  })

  it('S-27: rejects duplicate names, missing zones and malformed identifiers', async () => {
    await DeliveryZoneModel.create({ code: 'NORTE', normalizedName: 'norte', name: 'Norte', active: true })
    const sur = await DeliveryZoneModel.create({ code: 'SUR', normalizedName: 'sur', name: 'Sur', active: true })

    const duplicateName = await patchZone(String(sur._id), { name: ' norte ' })
    const missing = await patchZone(new Types.ObjectId().toString(), { active: false })
    const malformed = await patchZone('not-an-object-id', { active: false })
    const empty = await patchZone(String(sur._id), {})

    expect(duplicateName.status).to.equal(409)
    expect(duplicateName.body.code).to.equal('DUPLICATE_DELIVERY_ZONE_NAME')
    expect(missing.status).to.equal(404)
    expect(missing.body.code).to.equal('DELIVERY_ZONE_NOT_FOUND')
    expect(malformed.status).to.equal(400)
    expect(malformed.body.code).to.equal('INVALID_ROUTE_INPUT')
    expect(empty.status).to.equal(400)
    expect(empty.body.code).to.equal('INVALID_ROUTE_INPUT')
  })
})
