import { expect } from 'chai'
import sinon from 'sinon'
import { Types } from 'mongoose'
import RoutePlanModel from '../../src/models/routePlan'
import ProductModel from '../../src/models/product'
import RouteSimulationModel from '../../src/models/routeSimulation'
import * as routePlan from '../../src/services/routePlan'
import { createRealRouteScenario } from '../../src/services/routeSimulation'

describe('real route scenario', () => {
  const routeId = '000000000000000000000001'
  const productId = '000000000000000000000002'
  const input = { routeId, parameters: { fuelPricePerLiter: 10, hourlyRate: 20, generalCosts: 5, includeSurplus: true }, products: [{ id: productId, quantity: 3 }] }
  const snapshot = { _id: new Types.ObjectId(routeId), metrics: { fuelLiters: 2, durationSeconds: 5400 } }
  const query = (value: unknown): never => {
    const result = { lean: async () => value }
    return result as never
  }
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
