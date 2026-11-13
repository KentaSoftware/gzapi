import { expect } from 'chai'
import sinon from 'sinon'
import { Types } from 'mongoose'
import RoutePlanModel from '../../src/models/routePlan'
import RoutePlanOperationalModel from '../../src/models/routePlanOperational'
import ProductModel from '../../src/models/product'
import RouteSimulationModel from '../../src/models/routeSimulation'
import UserModel from '../../src/models/user'
import VehicleModel from '../../src/models/vehicle'
import * as routePlan from '../../src/services/routePlan'
import { createRealRouteScenario, getRealRouteScenario } from '../../src/services/routeSimulation'

describe('real route scenario', () => {
  const routeId = '000000000000000000000001'
  const productId = '000000000000000000000002'
  const input = { routeId, parameters: { fuelPricePerLiter: 10, hourlyRate: 20, generalCosts: 5, includeSurplus: true }, products: [{ id: productId, quantity: 3 }] }
  const snapshot = { _id: new Types.ObjectId(routeId), metrics: { fuelLiters: 2, durationSeconds: 5400 } }
  const query = (value: unknown): never => {
    const result = { lean: async () => value }
    return result as never
  }
  let operationalProjection: sinon.SinonStub
  beforeEach(() => {
    operationalProjection = sinon.stub(RoutePlanOperationalModel, 'findOne').returns(query(null))
  })
  afterEach(() => sinon.restore())

  it('uses the exact saved route and current prices, freezing inputs and the existing formula', async () => {
    const findRoute = sinon.stub(RoutePlanModel, 'findById').returns(query(snapshot))
    sinon.stub(ProductModel, 'find').returns(query([{ _id: new Types.ObjectId(productId), descripcion: 'Product', precioUnitario: 12.5, stock: 3 }]))
    const create = sinon.stub(RouteSimulationModel, 'create').callsFake(async (record: unknown) => Object.assign({}, record, { _id: new Types.ObjectId('000000000000000000000003') }) as never)
    const result = await createRealRouteScenario(input, { kind: 'global' })
    expect(String(findRoute.firstCall.args[0])).to.equal(routeId)
    expect(result).to.include({ routeId, estimatedRevenue: 38, operatingCost: 55, grossMargin: -17 })
    expect(result.products).to.deep.equal([{ id: productId, name: 'Product', unitPrice: 12.5, quantity: 3, stock: 3 }])
    expect(result.parameters).to.deep.equal(input.parameters)
    expect(result.routeMetrics).to.deep.equal({ fuelLiters: 2, durationHours: 1.5 })
    expect(create.calledOnce).to.equal(true)
  })

  it('freezes route date, zone, order count, metrics and effective assignment labels', async () => {
    const completeSnapshot = {
      ...snapshot,
      planningDate: new Date('2026-05-15T00:00:00.000Z'),
      zoneSnapshot: { code: 'NORTH', name: 'North zone' },
      selectedSaleIds: ['sale-1', 'sale-2', 'sale-3'],
      metrics: { distanceMeters: 12500, fuelLiters: 2, durationSeconds: 5400 },
      assignments: { driverId: 'old-driver', vehicleId: 'old-vehicle' }
    }
    sinon.stub(RoutePlanModel, 'findById').returns(query(completeSnapshot))
    operationalProjection.returns(query({ assignments: { driverId: '000000000000000000000004', vehicleId: '000000000000000000000005' } }))
    sinon.stub(UserModel, 'findById').callsFake((id: unknown) => query({ _id: id, nickname: 'Current driver' }))
    sinon.stub(VehicleModel, 'findById').callsFake((id: unknown) => query({ _id: id, code: 'TRUCK-1' }))
    sinon.stub(ProductModel, 'find').returns(query([{ _id: new Types.ObjectId(productId), descripcion: 'Product', precioUnitario: 12.5, stock: 3 }]))
    const create = sinon.stub(RouteSimulationModel, 'create').callsFake(async (record: unknown) => Object.assign({}, record, { _id: new Types.ObjectId('000000000000000000000003') }) as never)

    await createRealRouteScenario(input, { kind: 'global' })

    expect(create.firstCall.args[0]).to.have.property('routeSnapshot').that.deep.equals({
      date: completeSnapshot.planningDate,
      zone: 'North zone',
      saleIds: ['sale-1', 'sale-2', 'sale-3'],
      orderCount: 3,
      distanceKm: 12.5,
      fuelLiters: 2,
      durationHours: 1.5,
      driverId: '000000000000000000000004',
      driver: 'Current driver',
      vehicleId: '000000000000000000000005',
      vehicle: 'TRUCK-1'
    })
  })

  it('hydrates route metadata for a legacy scenario from the saved route snapshot', async () => {
    const scenarioId = '000000000000000000000003'
    const driverId = '000000000000000000000004'
    const vehicleId = '000000000000000000000005'
    const planningDate = new Date('2026-05-15T00:00:00.000Z')
    const savedRoute = {
      ...snapshot,
      planningDate,
      zoneSnapshot: { code: 'NORTH', name: 'North zone' },
      selectedSaleIds: ['sale-1', 'sale-2', 'sale-3'],
      metrics: { distanceMeters: 12500, fuelLiters: 2, durationSeconds: 5400 },
      assignments: { driverId, vehicleId }
    }
    const scenario = {
      _id: new Types.ObjectId(scenarioId),
      routeId,
      routeMetrics: { fuelLiters: 2, durationHours: 1.5 },
      parameters: input.parameters,
      products: [],
      estimatedRevenue: 38,
      operatingCost: 55,
      grossMargin: -17
    }
    sinon.stub(RouteSimulationModel, 'findById').returns(query(scenario))
    sinon.stub(RoutePlanModel, 'findById').returns(query(savedRoute))
    sinon.stub(UserModel, 'find').returns(query([{ _id: new Types.ObjectId(driverId), nickname: 'Saved driver' }]))
    sinon.stub(VehicleModel, 'find').returns(query([{ _id: new Types.ObjectId(vehicleId), code: 'SAVED-TRUCK' }]))

    const result = await getRealRouteScenario(scenarioId, { kind: 'global' })

    expect(result).to.not.equal(null)
    expect(result).to.include({ routeId, estimatedRevenue: 38, operatingCost: 55, grossMargin: -17 })
    expect(result?.routeSnapshot).to.deep.equal({
      date: planningDate,
      zone: 'North zone',
      saleIds: ['sale-1', 'sale-2', 'sale-3'],
      orderCount: 3,
      distanceKm: 12.5,
      fuelLiters: 2,
      durationHours: 1.5,
      driverId,
      driver: 'Saved driver',
      vehicleId,
      vehicle: 'SAVED-TRUCK'
    })
  })

  it('hydrates visible legacy detail from the current effective assignment without an unscoped route read', async () => {
    const scenarioId = '000000000000000000000003'
    const driverId = '000000000000000000000006'
    const vehicleId = '000000000000000000000007'
    const scenario = {
      _id: new Types.ObjectId(scenarioId),
      routeId,
      routeMetrics: { fuelLiters: 2, durationHours: 1.5 },
      parameters: input.parameters,
      products: [],
      estimatedRevenue: 38,
      operatingCost: 55,
      grossMargin: -17
    }
    sinon.stub(RouteSimulationModel, 'findById').returns(query(scenario))
    const findDriverRoutes = sinon.stub(routePlan, 'getDriverSnapshots').resolves([{
      snapshot: { ...snapshot, assignments: { driverId: 'former-driver', vehicleId: 'former-vehicle' } },
      projection: { assignments: { driverId, vehicleId } }
    }] as never)
    const findRoute = sinon.stub(RoutePlanModel, 'findById')
    sinon.stub(UserModel, 'find').returns(query([{ _id: new Types.ObjectId(driverId), nickname: 'Current driver' }]))
    sinon.stub(VehicleModel, 'find').returns(query([{ _id: new Types.ObjectId(vehicleId), code: 'CURRENT-TRUCK' }]))

    const result = await getRealRouteScenario(scenarioId, { kind: 'driver', userId: driverId })

    expect(findDriverRoutes.firstCall.args[0]).to.equal(driverId)
    expect(findRoute.called).to.equal(false)
    expect(result?.routeSnapshot).to.include({ driverId, driver: 'Current driver', vehicleId, vehicle: 'CURRENT-TRUCK' })
  })

  it('denies a former driver after the route is reassigned', async () => {
    const scenarioId = '000000000000000000000003'
    const formerDriverId = '000000000000000000000004'
    const scenario = {
      _id: new Types.ObjectId(scenarioId),
      routeId,
      routeSnapshot: { driverId: formerDriverId },
      estimatedRevenue: 38,
      operatingCost: 55,
      grossMargin: -17
    }
    sinon.stub(RouteSimulationModel, 'findById').returns(query(scenario))
    const findDriverRoutes = sinon.stub(routePlan, 'getDriverSnapshots').resolves([])
    const findRoute = sinon.stub(RoutePlanModel, 'findById')

    const result = await getRealRouteScenario(scenarioId, { kind: 'driver', userId: formerDriverId })

    expect(result).to.equal(null)
    expect(findDriverRoutes.firstCall.args[0]).to.equal(formerDriverId)
    expect(findRoute.called).to.equal(false)
  })

  it('preserves frozen route metadata when it is already stored', async () => {
    const scenarioId = '000000000000000000000003'
    const frozenMetadata = {
      date: new Date('2026-05-10T00:00:00.000Z'),
      zone: 'Frozen zone',
      orderCount: 8,
      distanceKm: 42,
      fuelLiters: 7,
      durationHours: 3,
      driverId: '000000000000000000000004',
      driver: 'Frozen driver',
      vehicleId: '000000000000000000000005',
      vehicle: 'FROZEN-TRUCK'
    }
    const scenario = {
      _id: new Types.ObjectId(scenarioId),
      routeId,
      routeSnapshot: frozenMetadata,
      routeMetrics: { fuelLiters: 2, durationHours: 1.5 },
      parameters: input.parameters,
      products: [],
      estimatedRevenue: 38,
      operatingCost: 55,
      grossMargin: -17
    }
    sinon.stub(RouteSimulationModel, 'findById').returns(query(scenario))
    sinon.stub(RoutePlanModel, 'findById').returns(query({
      ...snapshot,
      planningDate: new Date('2026-06-01T00:00:00.000Z'),
      zoneSnapshot: { code: 'OTHER', name: 'Current zone' },
      selectedSaleIds: ['different-sale'],
      metrics: { distanceMeters: 90000, fuelLiters: 20, durationSeconds: 9000 },
      assignments: { driverId: '000000000000000000000006', vehicleId: '000000000000000000000007' }
    }))

    const result = await getRealRouteScenario(scenarioId, { kind: 'global' })

    expect(result?.routeSnapshot).to.deep.equal({ ...frozenMetadata, saleIds: ['different-sale'] })
  })

  it('denies drivers without visibility of the exact route', async () => {
    const driver = sinon.stub(routePlan, 'getDriverSnapshots').resolves([])
    const create = sinon.stub(RouteSimulationModel, 'create')
    let error: unknown
    try { await createRealRouteScenario(input, { kind: 'driver', userId: 'driver' }) } catch (caught) { error = caught }
    expect(error).to.be.instanceOf(Error)
    expect(driver.firstCall.args[1]).to.deep.equal({ _id: new Types.ObjectId(routeId) })
    expect(create.called).to.equal(false)
  })

  it('rejects missing route metrics and missing or non-finite product prices', async () => {
    const findRoute = sinon.stub(RoutePlanModel, 'findById').returns(query({ ...snapshot, metrics: { durationSeconds: 5 } }))
    const products = sinon.stub(ProductModel, 'find').returns(query([]))
    const create = sinon.stub(RouteSimulationModel, 'create')
    for (const record of [null, { _id: new Types.ObjectId(productId), descripcion: 'Product', precioUnitario: NaN }]) {
      let error: unknown
      try { await createRealRouteScenario(input, { kind: 'global' }) } catch (caught) { error = caught }
      expect(error).to.be.instanceOf(Error)
      findRoute.returns(query(snapshot))
      products.returns(query(record === null ? [] : [record]))
    }
    let error: unknown
    try { await createRealRouteScenario(input, { kind: 'global' }) } catch (caught) { error = caught }
    expect(error).to.be.instanceOf(Error)
    expect(create.called).to.equal(false)
  })

  it('rejects missing and invalid access scope before any database reads', async () => {
    const findRoute = sinon.stub(RoutePlanModel, 'findById')
    const driver = sinon.stub(routePlan, 'getDriverSnapshots')
    const invalidScopes: unknown[] = [undefined, null, {}, { kind: 'driver' }, { kind: 'driver', userId: ' ' }, { kind: 'other' }]
    for (const scope of invalidScopes) {
      let error: unknown
      try { await createRealRouteScenario(input, scope as Parameters<typeof createRealRouteScenario>[1]) } catch (caught) { error = caught }
      expect(error).to.be.instanceOf(Error)
    }
    expect(findRoute.called).to.equal(false)
    expect(driver.called).to.equal(false)
  })

  it('uses validated input copies when the caller mutates input during a route read', async () => {
    let release: (value: typeof snapshot) => void = () => { throw new Error('not initialized') }
    const pending = new Promise<typeof snapshot>((resolve) => { release = resolve })
    const routeQuery = { lean: async () => await pending }
    sinon.stub(RoutePlanModel, 'findById').returns(routeQuery as never)
    const findProducts = sinon.stub(ProductModel, 'find').returns(query([{ _id: new Types.ObjectId(productId), descripcion: 'Product', precioUnitario: 12.5, stock: 3 }]))
    const create = sinon.stub(RouteSimulationModel, 'create').callsFake(async (record: unknown) => Object.assign({}, record, { _id: new Types.ObjectId('000000000000000000000003') }) as never)
    const mutable = { routeId, parameters: { ...input.parameters }, products: input.products.map((product) => ({ ...product })) }
    const resultPromise = createRealRouteScenario(mutable, { kind: 'global' })
    mutable.routeId = '000000000000000000000099'
    mutable.parameters.hourlyRate = NaN
    mutable.parameters.fuelPricePerLiter = 999
    mutable.products[0].id = '000000000000000000000099'
    mutable.products[0].quantity = 999
    mutable.products.push({ id: '000000000000000000000098', quantity: 999 })
    release(snapshot)
    const result = await resultPromise
    expect(result).to.include({ routeId, estimatedRevenue: 38, operatingCost: 55, grossMargin: -17 })
    expect(result.parameters).to.deep.equal(input.parameters)
    expect(result.products).to.deep.equal([{ id: productId, name: 'Product', unitPrice: 12.5, quantity: 3, stock: 3 }])
    expect(findProducts.firstCall.args[0]).to.deep.equal({ _id: { $in: [new Types.ObjectId(productId)] } })
    const { id: _id, ...persisted } = result
    expect(create.firstCall.args[0]).to.deep.equal(persisted)
  })

  it('rejects more than the existing simulation direct-load limit', async () => {
    const findRoute = sinon.stub(RoutePlanModel, 'findById')
    const tooMany = { ...input, products: Array.from({ length: 10001 }, (_, index) => ({ id: index.toString(16).padStart(24, '0'), quantity: 1 })) }
    let error: unknown
    try { await createRealRouteScenario(tooMany, { kind: 'global' }) } catch (caught) { error = caught }
    expect(error).to.be.instanceOf(Error)
    expect(findRoute.called).to.equal(false)
  })

  it('aggregates duplicate IDs and accepts the exact current stock boundary', async () => {
    const id = 'aaaaaaaaaaaaaaaaaaaaaaaa'
    sinon.stub(RoutePlanModel, 'findById').returns(query(snapshot))
    const find = sinon.stub(ProductModel, 'find').returns(query([{ _id: new Types.ObjectId(id), descripcion: 'Product', precioUnitario: 12.5, stock: 3 }]))
    const create = sinon.stub(RouteSimulationModel, 'create').callsFake(async (record: unknown) => Object.assign({}, record, { _id: new Types.ObjectId() }) as never)
    const result = await createRealRouteScenario({ ...input, products: [{ id, quantity: 1 }, { id: id.toUpperCase(), quantity: 2 }] }, { kind: 'global' })
    expect(result.products).to.deep.equal([{ id, name: 'Product', unitPrice: 12.5, quantity: 3, stock: 3 }])
    expect(result.estimatedRevenue).to.equal(38)
    expect(find.firstCall.args[0]).to.deep.equal({ _id: { $in: [new Types.ObjectId(id)] } })
    expect(find.firstCall.args[1]).to.include({ stock: 1 })
    expect(create.calledOnce).to.equal(true)
  })

  it('rejects quantities exceeding stock, including aggregated duplicates', async () => {
    sinon.stub(RoutePlanModel, 'findById').returns(query(snapshot))
    sinon.stub(ProductModel, 'find').returns(query([{ _id: new Types.ObjectId(productId), descripcion: 'Product', precioUnitario: 12.5, stock: 3 }]))
    const create = sinon.stub(RouteSimulationModel, 'create')
    for (const products of [[{ id: productId, quantity: 4 }], [{ id: productId, quantity: 2 }, { id: productId, quantity: 2 }]]) {
      let error: unknown
      try { await createRealRouteScenario({ ...input, products }, { kind: 'global' }) } catch (caught) { error = caught }
      expect(error).to.be.instanceOf(Error)
    }
    expect(create.called).to.equal(false)
  })

  it('rejects fractional quantities and unavailable stock without persisting', async () => {
    const route = sinon.stub(RoutePlanModel, 'findById').returns(query(snapshot))
    const find = sinon.stub(ProductModel, 'find')
    const create = sinon.stub(RouteSimulationModel, 'create')
    let error: unknown
    try { await createRealRouteScenario({ ...input, products: [{ id: productId, quantity: 1.5 }] }, { kind: 'global' }) } catch (caught) { error = caught }
    expect(error).to.be.instanceOf(Error)
    expect(route.called).to.equal(false)
    for (const stock of [undefined, NaN, Infinity, -1]) {
      find.returns(query([{ _id: new Types.ObjectId(productId), descripcion: 'Product', precioUnitario: 12.5, stock }]))
      error = undefined
      try { await createRealRouteScenario(input, { kind: 'global' }) } catch (caught) { error = caught }
      expect(error).to.be.instanceOf(Error)
    }
    expect(create.called).to.equal(false)
  })
})
