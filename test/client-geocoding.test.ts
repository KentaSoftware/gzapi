import { expect } from 'chai'
import mongoose from 'mongoose'
import request from 'supertest'
import sinon from 'sinon'

import ClientModel from '../src/models/client'
import RoleModel from '../src/models/role'
import UserModel from '../src/models/user'
import { generateToken } from '../src/utils/jwt.handle'
import * as geocodingProvider from '../src/services/geocodingProvider'

const TEST_DB_URI = 'mongodb://localhost:27017/gzapi_client_geocoding_test'

describe('Client geocoding', () => {
  let app: Awaited<ReturnType<typeof import('../src/app').createApp>>
  let authorizedToken: string
  let unauthorizedToken: string
  let authorizedUserId: string

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
    await ClientModel.deleteMany({})
    await UserModel.deleteMany({})
    await RoleModel.deleteMany({})

    const authorizedRole = await RoleModel.create({
      name: 'Location confirmer',
      permissions: ['confirm_client_location']
    })
    const unauthorizedRole = await RoleModel.create({
      name: 'Client editor',
      permissions: ['update_client']
    })
    const authorizedUser = await UserModel.create({
      nickname: 'location-confirmer',
      password: 'not-a-real-password',
      role: authorizedRole._id
    })
    const unauthorizedUser = await UserModel.create({
      nickname: 'client-editor',
      password: 'not-a-real-password',
      role: unauthorizedRole._id
    })

    authorizedUserId = String(authorizedUser._id)
    authorizedToken = await generateToken(authorizedUser)
    unauthorizedToken = await generateToken(unauthorizedUser)
  })

  afterEach(() => {
    sinon.restore()
  })

  it('S-12: returns normalized ambiguous candidates without confirming the client', async () => {
    const client = await ClientModel.create({ nombreCompleto: 'Ambiguous client', address: 'Original address' })
    const geocode = sinon.stub(geocodingProvider, 'geocode').resolves([
      { formattedAddress: 'Candidate one', placeId: 'place-one', precision: 'ROOFTOP', lat: -34.6, lng: -58.4 },
      { formattedAddress: 'Candidate two', placeId: 'place-two', precision: 'APPROXIMATE', lat: -34.61, lng: -58.41 }
    ])

    const response = await request(app)
      .post(`/client/${String(client._id)}/geocode`)
      .set('Authorization', `Bearer ${authorizedToken}`)
      .send({ address: 'Search address' })

    expect(response.status).to.equal(200)
    expect(response.body.candidates).to.deep.equal([
      { formattedAddress: 'Candidate one', placeId: 'place-one', precision: 'ROOFTOP', lat: -34.6, lng: -58.4 },
      { formattedAddress: 'Candidate two', placeId: 'place-two', precision: 'APPROXIMATE', lat: -34.61, lng: -58.41 }
    ])
    expect(geocode.calledOnceWithExactly({ address: 'Search address' })).to.equal(true)

    const stored = await ClientModel.findById(client._id).lean()
    expect(stored?.geocoding).to.equal(undefined)
  })

  it('S-12: denies geocoding to a user with update_client but without confirm_client_location', async () => {
    const client = await ClientModel.create({ nombreCompleto: 'Protected client', address: 'Original address' })
    const geocode = sinon.stub(geocodingProvider, 'geocode')

    const response = await request(app)
      .post(`/client/${String(client._id)}/geocode`)
      .set('Authorization', `Bearer ${unauthorizedToken}`)
      .send({ address: 'Search address' })

    expect(response.status).to.equal(403)
    expect(response.body.code).to.equal('PERMISSION_DENIED')
    expect(geocode.called).to.equal(false)
  })

  it('S-12: reports an unavailable geocoding provider without making a location change', async () => {
    const client = await ClientModel.create({ nombreCompleto: 'Unavailable client', address: 'Original address' })
    sinon.stub(geocodingProvider, 'geocode').rejects(new geocodingProvider.GeocodingProviderUnavailableError())

    const response = await request(app)
      .post(`/client/${String(client._id)}/geocode`)
      .set('Authorization', `Bearer ${authorizedToken}`)
      .send({})

    expect(response.status).to.equal(503)
    expect(response.body.code).to.equal('GEOCODING_PROVIDER_UNAVAILABLE')
    expect((await ClientModel.findById(client._id).lean())?.geocoding).to.equal(undefined)
  })

  it('S-12: confirms only the provider candidate explicitly selected by an authorized user', async () => {
    const client = await ClientModel.create({ nombreCompleto: 'Confirmable client', address: 'Original address' })

    const response = await request(app)
      .post(`/client/${String(client._id)}/location-confirmation`)
      .set('Authorization', `Bearer ${authorizedToken}`)
      .send({
        candidate: {
          formattedAddress: 'Confirmed address',
          placeId: 'confirmed-place',
          precision: 'ROOFTOP',
          lat: -34.6,
          lng: -58.4
        }
      })

    expect(response.status).to.equal(200)
    const stored = await ClientModel.findById(client._id).lean()
    expect(stored?.address).to.equal('Confirmed address')
    expect(stored?.lat).to.equal(-34.6)
    expect(stored?.lng).to.equal(-58.4)
    expect(stored?.geocoding?.status).to.equal('CONFIRMED')
    expect(stored?.geocoding?.source).to.equal('GEOCODED')
    expect(stored?.geocoding?.placeId).to.equal('confirmed-place')
    expect(stored?.geocoding?.validatedBy?.toString()).to.equal(authorizedUserId)
    expect(stored?.geocoding?.validatedAt).to.be.instanceOf(Date)
  })

  it('S-14: persists a manual reference as pending and never confirms it automatically', async () => {
    const client = await ClientModel.create({ nombreCompleto: 'Manual client', address: 'Original address', lat: -34.6, lng: -58.4 })

    const response = await request(app)
      .post(`/client/${String(client._id)}/location-confirmation`)
      .set('Authorization', `Bearer ${authorizedToken}`)
      .send({ manualReference: { address: 'Call before delivery' } })

    expect(response.status).to.equal(200)
    const stored = await ClientModel.findById(client._id).lean()
    expect(stored?.address).to.equal('Call before delivery')
    expect(stored?.lat).to.equal(undefined)
    expect(stored?.lng).to.equal(undefined)
    expect(stored?.geocoding?.status).to.equal('PENDING')
    expect(stored?.geocoding?.source).to.equal('MANUAL')
    expect(stored?.geocoding?.validatedBy?.toString()).to.equal(authorizedUserId)
    expect(stored?.geocoding?.validatedAt).to.equal(undefined)
  })

  it('S-14: keeps manual coordinates pending and rejects incomplete coordinate input', async () => {
    const client = await ClientModel.create({ nombreCompleto: 'Manual coordinates client' })

    const invalidResponse = await request(app)
      .post(`/client/${String(client._id)}/location-confirmation`)
      .set('Authorization', `Bearer ${authorizedToken}`)
      .send({ manualReference: { address: 'Incomplete coordinates', lat: -34.6 } })

    expect(invalidResponse.status).to.equal(400)
    expect((await ClientModel.findById(client._id).lean())?.geocoding).to.equal(undefined)

    const response = await request(app)
      .post(`/client/${String(client._id)}/location-confirmation`)
      .set('Authorization', `Bearer ${authorizedToken}`)
      .send({ manualReference: { address: 'Manual coordinates', lat: -34.6, lng: -58.4 } })

    expect(response.status).to.equal(200)
    const stored = await ClientModel.findById(client._id).lean()
    expect(stored?.lat).to.equal(-34.6)
    expect(stored?.lng).to.equal(-58.4)
    expect(stored?.geocoding?.status).to.equal('PENDING')
    expect(stored?.geocoding?.source).to.equal('MANUAL')
  })
})
