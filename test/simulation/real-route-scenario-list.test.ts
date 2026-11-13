import { expect } from 'chai'
import sinon from 'sinon'
import { Types } from 'mongoose'
import RoutePlanModel from '../../src/models/routePlan'
import RouteSimulationModel from '../../src/models/routeSimulation'
import UserModel from '../../src/models/user'
import VehicleModel from '../../src/models/vehicle'
import * as routePlan from '../../src/services/routePlan'
import { listRealRouteScenarios } from '../../src/services/routeSimulation'

describe('real route scenario history', () => {
  const routeIds = [
    '000000000000000000000001',
    '000000000000000000000002',
    '000000000000000000000003',
    '000000000000000000000004'
  ]
  const scenario = (index: number, routeSnapshot?: unknown): Record<string, unknown> => ({
    _id: new Types.ObjectId((index + 10).toString(16).padStart(24, '0')),
    routeId: routeIds[index],
    createdAt: new Date(`2026-05-0${index + 1}T10:00:00.000Z`),
    routeMetrics: { fuelLiters: index + 1, durationHours: index + 2 },
    estimatedRevenue: 100 + index,
    operatingCost: 40 + index,
    grossMargin: 60,
    ...(routeSnapshot === undefined ? {} : { routeSnapshot })
  })
  const route = (index: number): Record<string, unknown> => ({
    _id: new Types.ObjectId(routeIds[index]),
    planningDate: new Date(`2026-05-0${index + 1}T00:00:00.000Z`),
    zoneSnapshot: { code: `Z${index}`, name: `Zone ${index}` },
    selectedSaleIds: [`sale-${index}-1`, `sale-${index}-2`],
    metrics: { distanceMeters: (index + 1) * 1000, fuelLiters: index + 1, durationSeconds: (index + 1) * 3600 },
    assignments: { driverId: `driver-${index}`, vehicleId: `vehicle-${index}` }
  })
  const query = (value: unknown): never => {
    const result = { lean: async () => value }
    return result as never
  }
  const sortedQuery = (value: unknown): never => {
    const result = { sort: () => query(value) }
    return result as never
  }

  afterEach(() => sinon.restore())

  it('returns global paginated summaries and hydrates legacy metadata from the saved route', async () => {
    const scenarios = [scenario(0), scenario(1, {
      date: new Date('2026-05-02T00:00:00.000Z'),
      zone: 'Frozen zone',
      orderCount: 8,
      distanceKm: 9,
      fuelLiters: 10,
      durationHours: 11,
      driverId: 'frozen-driver',
      driver: 'Frozen driver',
      vehicleId: 'frozen-vehicle',
      vehicle: 'Frozen vehicle'
    }), scenario(2), scenario(3)]
    sinon.stub(RouteSimulationModel, 'find').returns(sortedQuery(scenarios))
    sinon.stub(RoutePlanModel, 'find').returns(query([route(0), route(1), route(2)]))

    const result = await listRealRouteScenarios(1, { kind: 'global' })

    expect(result).to.include({ page: 1, pageSize: 8, total: 3 })
    expect(result.items).to.have.length(3)
    expect(result.items[0]).to.include({
      id: '00000000000000000000000a',
      routeId: routeIds[0],
      zone: 'Zone 0',
      orderCount: 2,
      distanceKm: 1,
      fuelLiters: 1,
      durationHours: 1,
      estimatedRevenue: 100,
      operatingCost: 40,
      grossMargin: 60
    })
    expect(result.items[1]).to.include({
      routeId: routeIds[1],
      zone: 'Frozen zone',
      orderCount: 8,
      distanceKm: 9,
      fuelLiters: 10,
      durationHours: 11,
      driverId: 'frozen-driver',
      driver: 'Frozen driver',
      vehicleId: 'frozen-vehicle',
      vehicle: 'Frozen vehicle'
    })
  })

  it('uses current effective driver assignment and excludes reassigned or missing routes', async () => {
    const scenarios = [scenario(0), scenario(1), scenario(2)]
    sinon.stub(RouteSimulationModel, 'find').returns(sortedQuery(scenarios))
    const authorized = sinon.stub(routePlan, 'getDriverSnapshots').resolves([
      { snapshot: route(1), projection: { assignments: { driverId: 'current-driver', vehicleId: 'current-vehicle' } } }
    ] as never)

    const result = await listRealRouteScenarios(1, { kind: 'driver', userId: 'current-driver' })

    expect(authorized.firstCall.args[0]).to.equal('current-driver')
    expect(authorized.firstCall.args[1]).to.deep.equal({ _id: { $in: routeIds.slice(0, 3).map((id) => new Types.ObjectId(id)) } })
    expect(result.total).to.equal(1)
    expect(result.items.map((item) => item.routeId)).to.deep.equal([routeIds[1]])
    expect(result.items[0]).to.include({ driverId: 'current-driver', driver: 'current-driver', vehicleId: 'current-vehicle', vehicle: 'current-vehicle' })
  })

  it('resolves saved assignment IDs to related names and falls back to IDs for missing records', async () => {
    const driverId = '000000000000000000000011'
    const vehicleId = '000000000000000000000012'
    const missingDriverId = '000000000000000000000013'
    const missingVehicleId = '000000000000000000000014'
    const scenarios = [scenario(0), scenario(1)]
    const firstRoute = { ...route(0), assignments: { driverId, vehicleId } }
    const secondRoute = { ...route(1), assignments: { driverId: missingDriverId, vehicleId: missingVehicleId } }
    sinon.stub(RouteSimulationModel, 'find').returns(sortedQuery(scenarios))
    sinon.stub(RoutePlanModel, 'find').returns(query([firstRoute, secondRoute]))
    const drivers = sinon.stub(UserModel, 'find').returns(query([{ _id: new Types.ObjectId(driverId), nickname: 'Current driver' }]))
    const vehicles = sinon.stub(VehicleModel, 'find').returns(query([{ _id: new Types.ObjectId(vehicleId), code: 'TRUCK-12' }]))

    const result = await listRealRouteScenarios(1, { kind: 'global' })

    expect(drivers.firstCall.args[0]).to.deep.equal({ _id: { $in: [new Types.ObjectId(driverId), new Types.ObjectId(missingDriverId)] } })
    expect(vehicles.firstCall.args[0]).to.deep.equal({ _id: { $in: [new Types.ObjectId(vehicleId), new Types.ObjectId(missingVehicleId)] } })
    expect(result.items[0]).to.include({ driverId, driver: 'Current driver', vehicleId, vehicle: 'TRUCK-12' })
    expect(result.items[1]).to.include({ driverId: missingDriverId, driver: missingDriverId, vehicleId: missingVehicleId, vehicle: missingVehicleId })
  })

  it('paginates after applying access and rejects invalid page numbers before reads', async () => {
    const scenarios = Array.from({ length: 10 }, (_, index) => scenario(index % 3))
    const find = sinon.stub(RouteSimulationModel, 'find').returns(sortedQuery(scenarios))
    sinon.stub(RoutePlanModel, 'find').returns(query([route(0), route(1), route(2)]))

    const secondPage = await listRealRouteScenarios(2, { kind: 'global' })
    expect(secondPage).to.include({ page: 2, pageSize: 8, total: 10 })
    expect(secondPage.items).to.have.length(2)

    find.resetHistory()
    for (const page of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      let error: unknown
      try { await listRealRouteScenarios(page, { kind: 'global' }) } catch (caught) { error = caught }
      expect(error).to.be.instanceOf(Error)
    }
    expect(find.called).to.equal(false)
  })
})
