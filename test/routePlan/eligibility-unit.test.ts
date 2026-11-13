import { expect } from 'chai'
import sinon from 'sinon'
import { Types } from 'mongoose'
import SaleModel from '../../src/models/sale'
import ClientModel from '../../src/models/client'
import DeliveryZoneModel from '../../src/models/deliveryZone'
import RoutingConfigModel from '../../src/models/routingConfig'
import ItemSaleModel from '../../src/models/itemSale'
import RoutePlanModel from '../../src/models/routePlan'
import * as provider from '../../src/services/routeMatrixProvider'
import { getCandidates, getGlobalCandidates, preview, RoutePreviewError } from '../../src/services/routePlan'
import type { CandidateResult } from '../../src/interfaces/routeOptimization.interface'
import { assignmentGuard } from '../../src/services/routeAssignment'

describe('route eligibility without database access', () => {
  const zone = new Types.ObjectId()
  const clientId = new Types.ObjectId()
  const date = '2026-11-08'
  const input = { serviceDate: date, deliveryZoneId: String(zone), driverId: String(new Types.ObjectId()), vehicleId: String(new Types.ObjectId()) }
  let sales: Array<Record<string, unknown>>
  let clients: Array<Record<string, unknown>>

  const query = (rows: unknown): unknown => {
    let limit = Infinity
    const result = {
      sort: () => result,
      limit: (value: number) => { limit = value; return result },
      lean: () => ({
        then: async (resolve: (value: unknown) => unknown) => await Promise.resolve(Array.isArray(rows) ? rows.slice(0, limit) : rows).then(resolve),
        cursor: () => ({ async * [Symbol.asyncIterator] () { for (const row of rows as unknown[]) yield row } })
      })
    }
    return result
  }
  const sale = (estado: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    _id: new Types.ObjectId(),
    idCliente: clientId,
    estado,
    delivery: { status: 'PENDING', serviceDate: new Date('2026-11-08T12:00:00Z') },
    ...extra
  })

  beforeEach(() => {
    sinon.stub(assignmentGuard, 'readAssignedSnapshots').resolves([])
    sales = []
    clients = [{ _id: clientId, nombreCompleto: 'Client', address: 'Address', isActive: true, deliveryZoneId: zone, lat: 0, lng: 0, geocoding: { status: 'CONFIRMED' } }]
    sinon.stub(SaleModel, 'find').callsFake((filter: unknown) => {
      const conditions = filter as { _id?: { $in: unknown[] }, estado?: { $not: RegExp } }
      const rows = sales.filter((row) => (conditions._id === undefined || conditions._id.$in.map(String).includes(String(row._id))) && (conditions.estado === undefined || !conditions.estado.$not.test(String(row.estado ?? ''))))
      return query(rows) as never
    })
    sinon.stub(ClientModel, 'find').callsFake(() => query(clients) as never)
    sinon.stub(DeliveryZoneModel, 'findOne').callsFake(() => query({ name: 'Zone' }) as never)
    sinon.stub(DeliveryZoneModel, 'find').callsFake(() => query([{ _id: zone, name: 'North' }]) as never)
    sinon.stub(RoutingConfigModel, 'findOne').callsFake(() => query({ depot: { name: 'Depot', latitude: 0, longitude: 0 }, provider: 'test', algorithm: 'test', revision: 1 }) as never)
    sinon.stub(ItemSaleModel, 'find').callsFake(() => query([]) as never)
  })
  afterEach(() => { sinon.restore() })

  it('routes confirmed manual coordinates without an address and reports zone names for all candidates', async () => {
    const otherClient = new Types.ObjectId()
    sales = [sale('Creado'), sale('Creado', { idCliente: otherClient })]
    clients = [
      { ...clients[0], address: undefined, geocoding: { status: 'CONFIRMED', source: 'MANUAL' } },
      { ...clients[0], _id: otherClient, lat: undefined, address: undefined }
    ]
    const zones = DeliveryZoneModel.find as sinon.SinonStub
    const result = await getGlobalCandidates()
    expect(result.eligible[0]).to.include({ zoneName: 'North', latitude: 0, longitude: 0 })
    expect(result.blocked[0]).to.include({ zoneName: 'North', locationIssue: 'COORDINATES_MISSING' })
    expect(zones.calledOnce).to.equal(true)
  })

  it('distinguishes missing, invalid and unconfirmed coordinates even when zone mismatch blocks first', async () => {
    sales = [sale('Creado')]
    const otherZone = new Types.ObjectId()
    clients[0].deliveryZoneId = otherZone
    for (const [lat, lng, status, issue] of [[undefined, 0, 'CONFIRMED', 'COORDINATES_MISSING'], [91, 0, 'CONFIRMED', 'COORDINATES_INVALID'], [0, 0, 'PENDING', 'UNCONFIRMED']] as const) {
      clients[0].lat = lat
      clients[0].lng = lng
      clients[0].geocoding = { status }
      const result = await getCandidates(input)
      expect(result.blocked[0].reasons).to.deep.equal(['CLIENT_ZONE_MISMATCH'])
      expect(result.blocked[0].locationIssue).to.equal(issue)
    }
  })

  it('processes over 1000 pending sales in bounded batches including late historical assignments and other zones', async () => {
    const otherZone = new Types.ObjectId()
    const otherClient = new Types.ObjectId()
    clients.push({ ...clients[0], _id: otherClient, deliveryZoneId: otherZone })
    sales = Array.from({ length: 1205 }, (_, i) => sale('Creado', { idCliente: i % 2 === 0 ? clientId : otherClient, delivery: { status: 'PENDING' } }))
    const assigned = new Set([String(sales[4]._id), String(sales[1204]._id)])
    const lookup = assignmentGuard.readAssignedSnapshots as sinon.SinonStub
    lookup.callsFake(async (ids: string[]) => ids.filter((id) => assigned.has(id)).map((id) => ({ selectedSaleIds: [id] })))
    const result = await getCandidates(input)
    expect(result.eligible).to.have.length(601)
    expect(result.blocked).to.have.length(602)
    expect(result.eligible.map((row) => row.saleId)).not.to.include(String(sales[1204]._id))
    expect(lookup.callCount).to.be.greaterThan(1)
    expect(Math.max(...lookup.args.map(([ids]) => (ids as string[]).length))).to.be.at.most(500)
    const clientReads = (ClientModel.find as sinon.SinonStub).args.map(([filter]) => (filter as { _id: { $in: unknown[] } })._id.$in.length)
    expect(Math.max(...clientReads)).to.be.at.most(500)
  })

  it('removes historical assignments from undated candidates without a delivery date filter', async () => {
    sales = [sale('Creado', { delivery: { status: 'PENDING' } }), sale('Creado', { delivery: { status: 'PENDING', serviceDate: new Date('2024-01-01') } })]
    ;(assignmentGuard.readAssignedSnapshots as sinon.SinonStub).resolves([{ selectedSaleIds: [String(sales[0]._id)] }])
    const result = await getCandidates(input)
    expect(result.eligible.map((entry) => entry.saleId)).to.deep.equal([String(sales[1]._id)])
    expect((SaleModel.find as sinon.SinonStub).firstCall.args[0]).not.to.have.property('delivery.serviceDate')
  })

  for (const scoped of [false, true]) {
    const candidates = async (): Promise<CandidateResult> => scoped ? await getCandidates(input) : await getGlobalCandidates()
    it(`excludes cancelled sales before limits and retains payment-neutral sales (${scoped ? 'scoped' : 'global'})`, async () => {
      sales = [sale(' Cancelado '), sale('Creado'), sale('Modificado', { paidAt: new Date() }), sale('Cancelado', { idCliente: new Types.ObjectId() })]
      const context = { maxResults: 2, truncated: false }
      const result = scoped ? await getCandidates(input, context) : await getGlobalCandidates(context)
      expect(result.eligible.map((entry) => entry.saleId)).to.deep.equal([String(sales[1]._id), String(sales[2]._id)])
      expect(result.blocked).to.have.length(0)
      expect(context.truncated).to.equal(false)
      sales = [sale('Cancelado')]
      expect((await candidates()).eligible).to.have.length(0)
    })

    it(`validates coordinate bounds and accepts zero (${scoped ? 'scoped' : 'global'})`, async () => {
      sales = [sale('Creado')]
      for (const [lat, lng] of [[NaN, 0], [Infinity, 0], [-91, 0], [91, 0], [0, -181], [0, 181], ['0', 0], [null, 0]]) {
        clients[0].lat = lat
        clients[0].lng = lng
        const result = await candidates()
        expect(result.eligible).to.have.length(0)
        expect(result.blocked[0].reasons).to.deep.equal(['CLIENT_LOCATION_MISSING'])
      }
      for (const [lat, lng] of [[0, 0], [-90, -180], [90, 180]]) {
        clients[0].lat = lat
        clients[0].lng = lng
        expect((await candidates()).eligible).to.have.length(1)
      }
    })
  }

  it('rejects selected cancelled sales before providers or snapshot writes', async () => {
    sales = [sale('Creado'), sale(' cancelado ')]
    const matrix = sinon.stub(provider, 'computeMatrix').rejects(new Error('unexpected provider call'))
    const route = sinon.stub(provider, 'computeRoute').rejects(new Error('unexpected provider call'))
    const write = sinon.stub(RoutePlanModel, 'create').rejects(new Error('unexpected snapshot write'))
    const request = { ...input, saleIds: sales.map((row) => String(row._id)) }
    try {
      await preview(request, { actor: 'test' })
      expect.fail('Expected cancellation rejection')
    } catch (error) {
      expect(error).to.be.instanceOf(RoutePreviewError)
      expect((error as RoutePreviewError).code).to.equal('NO_ELIGIBLE_ORDERS')
      expect((error as Error).message).to.match(/cancel/i)
    }
    expect(matrix.callCount).to.equal(0)
    expect(route.callCount).to.equal(0)
    expect(write.callCount).to.equal(0)
  })
})
