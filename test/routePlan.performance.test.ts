import { expect } from 'chai'
import mongoose, { Types } from 'mongoose'
import sinon from 'sinon'
import request from 'supertest'

import ClientModel from '../src/models/client'
import DeliveryZoneModel from '../src/models/deliveryZone'
import RoleModel from '../src/models/role'
import RoutingConfigModel from '../src/models/routingConfig'
import SaleModel from '../src/models/sale'
import UserModel from '../src/models/user'
import * as routeMatrixProvider from '../src/services/routeMatrixProvider'
import { generateToken } from '../src/utils/jwt.handle'

const TEST_DB_URI = 'mongodb://localhost:27017/gzapi_route_plan_performance_test'
const SERVICE_DATE = '2026-10-05'
const SERVICE_DAY_START = new Date('2026-10-05T03:00:00.000Z')
const STOP_COUNT = 15
const WARM_UPS = 3
const SAMPLES = 20
const P95_LIMIT_MS = 5000

const percentile95 = (samples: number[]): number => {
  const ordered = [...samples].sort((left, right) => left - right)
  return ordered[Math.ceil(ordered.length * 0.95) - 1]
}

describe('Route plan preview performance', () => {
  let app: Awaited<ReturnType<typeof import('../src/app').createApp>>
  let authorizedToken: string
  let userId: Types.ObjectId
  let zoneId: Types.ObjectId
  let saleIds: Types.ObjectId[]

  const deterministicMatrix = (origins: Array<{ id: string }>): { segments: Array<{ fromId: string, toId: string, distanceMeters: number, durationSeconds: number }> } => ({
    segments: origins.flatMap((from, fromIndex) => origins
      .filter((to) => to.id !== from.id)
      .map((to, toIndex) => ({
        fromId: from.id,
        toId: to.id,
        distanceMeters: (fromIndex + toIndex + 1) * 1000,
        durationSeconds: (fromIndex + toIndex + 1) * 60
      })))
  })

  before(async () => {
    await mongoose.connect(TEST_DB_URI)
    const { createApp } = await import('../src/app')
    app = await createApp()
  })

  after(async () => {
    sinon.restore()
    const dbName = mongoose.connection.db?.databaseName
    if (dbName?.endsWith('_test') === true) await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
  })

  beforeEach(async () => {
    sinon.restore()
    await Promise.all([
      SaleModel.deleteMany({}),
      ClientModel.deleteMany({}),
      DeliveryZoneModel.deleteMany({}),
      RoutingConfigModel.deleteMany({}),
      UserModel.deleteMany({}),
      RoleModel.deleteMany({})
    ])

    const authorizedRole = await RoleModel.create({ name: 'Route planner', permissions: ['create_route_plan'] })
    const authorizedUser = await UserModel.create({ nickname: 'route-planner', password: 'not-a-real-password', role: authorizedRole._id })
    userId = authorizedUser._id
    authorizedToken = await generateToken(authorizedUser)

    const zone = await DeliveryZoneModel.create({ code: 'NORTE', normalizedName: 'norte', name: 'Norte', active: true })
    zoneId = zone._id
    await RoutingConfigModel.create({
      key: 'deposito_1',
      enabled: true,
      revision: 3,
      depot: { name: 'Deposito 1', latitude: -34.6, longitude: -58.4 },
      fuelConsumptionLitersPer100Km: 8.5,
      provider: 'google-routes',
      algorithm: 'nearest-neighbor-2opt-v1'
    })

    saleIds = []
    for (let index = 0; index < STOP_COUNT; index += 1) {
      const client = await ClientModel.create({
        nombreCompleto: `Performance customer ${index}`,
        address: `Performance address ${index}`,
        lat: -34.6 - index * 0.001,
        lng: -58.4 - index * 0.001,
        isActive: true,
        deliveryZoneId: zoneId,
        geocoding: { status: 'CONFIRMED', source: 'GEOCODED', validatedAt: new Date(), validatedBy: userId }
      })
      const sale = await SaleModel.create({
        estado: 'CREATED',
        total: 100,
        user: userId,
        cliente: client.nombreCompleto,
        idCliente: client._id,
        delivery: { status: 'PENDING', serviceDate: SERVICE_DAY_START }
      })
      saleIds.push(sale._id)
    }
  })

  it('NFR-001: local preview p95 is at most 5s with deterministic doubles and a representative fixture', async function () {
    this.timeout(60000)

    sinon.stub(routeMatrixProvider, 'computeMatrix').callsFake(async ({ origins }) => deterministicMatrix(origins))
    sinon.stub(routeMatrixProvider, 'computeRoute').resolves({ encodedPolyline: 'encoded-route', distanceMeters: 18000, durationSeconds: 1200 })

    const body = { serviceDate: SERVICE_DATE, deliveryZoneId: String(zoneId), saleIds: saleIds.map(String) }

    const execute = async (): Promise<request.Response> => await new Promise((resolve, reject) => {
      void request(app)
        .post('/routePlan/preview')
        .set('Authorization', `Bearer ${authorizedToken}`)
        .send(body)
        .end((error, response) => {
          if (error != null) reject(error)
          else resolve(response)
        })
    })

    for (let index = 0; index < WARM_UPS; index += 1) {
      const warmUp = await execute()
      expect(warmUp.status).to.equal(200)
    }

    const samples: number[] = []
    for (let index = 0; index < SAMPLES; index += 1) {
      const startedAt = process.hrtime.bigint()
      const response = await execute()
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
      expect(response.status).to.equal(200)
      expect(response.body.metrics.stopCount).to.equal(STOP_COUNT)
      samples.push(elapsedMs)
    }

    const p95 = percentile95(samples)
    console.log(`NFR-001 p95 milliseconds: ${p95.toFixed(2)}`)
    expect(p95, `NFR-001 preview p95 was ${p95.toFixed(2)}ms`).to.be.at.most(P95_LIMIT_MS)
  })
})
