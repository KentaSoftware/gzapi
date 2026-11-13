import RoutePlanModel from '../models/routePlan'
import RoutePlanOperationalModel from '../models/routePlanOperational'
import type { RoutePlan, RoutePlanOperational, RouteOperationalAssignment } from '../interfaces/routeOptimization.interface'
import { getDriverSnapshots, MAX_SNAPSHOT_LIST_READS } from './routePlan'
import { Types } from 'mongoose'
import ProductModel from '../models/product'
import RouteSimulationModel from '../models/routeSimulation'
import UserModel from '../models/user'
import VehicleModel from '../models/vehicle'
import { calculateDemoSimulation } from './simulationCalculation'
import type { SimulationDemoRunInput } from './simulation'
import type { RealRouteScenarioHistoryPage, RealRouteScenarioSnapshot, RealRouteScenarioSummary } from '../interfaces/simulation.interface'

interface RouteOption {
  _id: string
  planningDate: Date
  zoneSnapshot: RoutePlan['zoneSnapshot']
  metrics: RoutePlan['metrics']
  assignments: RouteOperationalAssignment | null
  orderCount?: number
  driver?: string
  vehicle?: string
}

interface RouteOptionsPage {
  items: RouteOption[]
  hasMore: boolean
  nextCursor: string | null
}

const listRouteOptions = async (driverId?: string, cursor?: string): Promise<RouteOptionsPage> => {
  const filter = cursor === undefined ? {} : { _id: { $lt: new Types.ObjectId(cursor) } }
  const limit = MAX_SNAPSHOT_LIST_READS + 1
  // listSnapshots persists staleness projections; this selection is read-only.
  const entries = driverId !== undefined
    ? await getDriverSnapshots(driverId, filter, { _id: -1 }, limit)
    : (await RoutePlanModel.aggregate<RoutePlan & { operational: RoutePlanOperational[] }>([
        { $match: filter },
        { $sort: { _id: -1 } },
        { $limit: limit },
        { $lookup: { from: RoutePlanOperationalModel.collection.name, let: { snapshotId: { $toString: '$_id' } }, pipeline: [{ $match: { $expr: { $eq: ['$snapshotId', '$$snapshotId'] } } }], as: 'operational' } }
      ])).map(({ operational, ...snapshot }) => ({ snapshot, projection: operational[0] }))
  const hasMore = entries.length > MAX_SNAPSHOT_LIST_READS
  const routeItems = entries.slice(0, MAX_SNAPSHOT_LIST_READS).map(({ snapshot, projection }) => ({
    _id: String(snapshot._id),
    planningDate: snapshot.planningDate,
    zoneSnapshot: snapshot.zoneSnapshot,
    metrics: snapshot.metrics,
    assignments: projection !== undefined ? projection.assignments : snapshot.assignments ?? null,
    ...(Array.isArray(snapshot.selectedSaleIds) ? { orderCount: snapshot.selectedSaleIds.length } : {})
  }))
  const driverIds = [...new Set(routeItems.flatMap(({ assignments }) => {
    const id = assignments?.driverId
    return validId(id) ? [id.toLowerCase()] : []
  }))]
  const vehicleIds = [...new Set(routeItems.flatMap(({ assignments }) => {
    const id = assignments?.vehicleId
    return validId(id) ? [id.toLowerCase()] : []
  }))]
  const [drivers, vehicles] = await Promise.all([
    driverIds.length === 0 ? Promise.resolve([]) : UserModel.find({ _id: { $in: driverIds.map((id) => new Types.ObjectId(id)) } }, { _id: 1, nickname: 1 }).lean(),
    vehicleIds.length === 0 ? Promise.resolve([]) : VehicleModel.find({ _id: { $in: vehicleIds.map((id) => new Types.ObjectId(id)) } }, { _id: 1, code: 1 }).lean()
  ])
  const driverNames = new Map(drivers.map((driver) => [String(driver._id).toLowerCase(), driver.nickname]))
  const vehicleCodes = new Map(vehicles.map((vehicle) => [String(vehicle._id).toLowerCase(), vehicle.code]))
  const items = routeItems.map((route) => {
    const driverId = route.assignments?.driverId
    const vehicleId = route.assignments?.vehicleId
    const driver = validId(driverId) ? driverNames.get(driverId.toLowerCase()) : undefined
    const vehicle = validId(vehicleId) ? vehicleCodes.get(vehicleId.toLowerCase()) : undefined
    return {
      ...route,
      ...(typeof driver === 'string' && driver.trim() !== '' ? { driver } : {}),
      ...(typeof vehicle === 'string' && vehicle.trim() !== '' ? { vehicle } : {})
    }
  })
  return { items, hasMore, nextCursor: hasMore ? items[items.length - 1]._id : null }
}

interface RouteCatalogItem {
  id: string
  name: string
  stock: number
  precioUnitario: number
}

interface RouteCatalogPage {
  items: RouteCatalogItem[]
  excludedCount: number
  hasMore: boolean
  nextCursor: string | null
}

const listRouteCatalog = async (cursor?: string): Promise<RouteCatalogPage> => {
  const filter = cursor === undefined ? {} : { _id: { $lt: new Types.ObjectId(cursor) } }
  const records = await ProductModel.find(filter, { _id: 1, descripcion: 1, stock: 1, precioUnitario: 1 })
    .sort({ _id: -1 }).limit(101).lean()
  const page = records.slice(0, 100)
  const items: RouteCatalogItem[] = []
  for (const product of page) {
    if (typeof product.descripcion !== 'string' || product.descripcion.trim() === '' ||
        typeof product.stock !== 'number' || !Number.isFinite(product.stock) || product.stock < 0 ||
        typeof product.precioUnitario !== 'number' || !Number.isFinite(product.precioUnitario) || product.precioUnitario < 0) continue
    items.push({ id: String(product._id), name: product.descripcion, stock: product.stock, precioUnitario: product.precioUnitario })
  }
  const hasMore = records.length > 100
  return { items, excludedCount: page.length - items.length, hasMore, nextCursor: hasMore ? String(page[page.length - 1]._id) : null }
}

interface RealRouteScenarioInput {
  routeId: string
  parameters: SimulationDemoRunInput['parameters']
  products: Array<{ id: string, quantity: number }>
}

interface RealRouteScenario {
  id: string
  routeId: string
  routeSnapshot?: RealRouteScenarioSnapshot
  routeMetrics: { fuelLiters: number, durationHours: number }
  parameters: SimulationDemoRunInput['parameters']
  products: Array<{ id: string, name: string, unitPrice: number, quantity: number, stock: number }>
  estimatedRevenue: number
  operatingCost: number
  grossMargin: number
}

const ACCESS_KIND = { GLOBAL: 'global', DRIVER: 'driver' } as const
interface GlobalAccess { kind: typeof ACCESS_KIND.GLOBAL }
interface DriverAccess { kind: typeof ACCESS_KIND.DRIVER, userId: string }
type RealRouteAccess = GlobalAccess | DriverAccess

const ROUTE_SCENARIO_HISTORY_PAGE_SIZE = 8

interface StoredRealRouteScenario {
  _id: unknown
  routeId: unknown
  routeSnapshot?: unknown
  routeMetrics?: unknown
  estimatedRevenue: unknown
  operatingCost: unknown
  grossMargin: unknown
}

const nonNegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id)
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const validateRealRouteAccess = (scope: RealRouteAccess): void => {
  if (scope == null || (scope.kind !== ACCESS_KIND.GLOBAL && scope.kind !== ACCESS_KIND.DRIVER) ||
      (scope.kind === ACCESS_KIND.DRIVER && (typeof scope.userId !== 'string' || scope.userId.trim() === ''))) throw new Error('Invalid access scope')
}

const isoDate = (value: unknown): string | undefined => {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : undefined
  return date !== undefined && Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

const routeScenarioSummary = (scenario: StoredRealRouteScenario, route: RoutePlan, effectiveAssignments?: RouteOperationalAssignment): RealRouteScenarioSummary | null => {
  if (!validId(scenario._id) && !(scenario._id instanceof Types.ObjectId)) return null
  if (!finiteNumber(scenario.estimatedRevenue) || !finiteNumber(scenario.operatingCost) || !finiteNumber(scenario.grossMargin)) return null
  const routeId = String(route._id)
  const metadata = isRecord(scenario.routeSnapshot) ? scenario.routeSnapshot : {}
  const metrics = route.metrics
  const date = isoDate(metadata.date) ?? isoDate(route.planningDate)
  const zone = typeof metadata.zone === 'string' && metadata.zone.trim() !== ''
    ? metadata.zone
    : typeof route.zoneSnapshot?.name === 'string' ? route.zoneSnapshot.name : undefined
  const orderCount = nonNegative(metadata.orderCount)
    ? metadata.orderCount
    : Array.isArray(route.selectedSaleIds) ? route.selectedSaleIds.length : undefined
  const distanceKm = nonNegative(metadata.distanceKm)
    ? metadata.distanceKm
    : metrics !== undefined && nonNegative(metrics.distanceMeters) ? metrics.distanceMeters / 1000 : undefined
  const fuelLiters = nonNegative(metadata.fuelLiters)
    ? metadata.fuelLiters
    : metrics !== undefined && nonNegative(metrics.fuelLiters) ? metrics.fuelLiters : undefined
  const durationHours = nonNegative(metadata.durationHours)
    ? metadata.durationHours
    : metrics !== undefined && nonNegative(metrics.durationSeconds) ? metrics.durationSeconds / 3600 : undefined
  const assignments = effectiveAssignments ?? route.assignments
  const driverId = typeof metadata.driverId === 'string' ? metadata.driverId : assignments?.driverId
  const vehicleId = typeof metadata.vehicleId === 'string' ? metadata.vehicleId : assignments?.vehicleId
  const summary: RealRouteScenarioSummary = {
    id: String(scenario._id),
    routeId,
    estimatedRevenue: scenario.estimatedRevenue,
    operatingCost: scenario.operatingCost,
    grossMargin: scenario.grossMargin
  }
  if (date !== undefined) summary.date = date
  if (zone !== undefined) summary.zone = zone
  if (driverId !== undefined) summary.driverId = driverId
  if (vehicleId !== undefined) summary.vehicleId = vehicleId
  if (typeof metadata.driver === 'string' && metadata.driver.trim() !== '') summary.driver = metadata.driver
  if (typeof metadata.vehicle === 'string' && metadata.vehicle.trim() !== '') summary.vehicle = metadata.vehicle
  if (orderCount !== undefined) summary.orderCount = orderCount
  if (distanceKm !== undefined) summary.distanceKm = distanceKm
  if (fuelLiters !== undefined) summary.fuelLiters = fuelLiters
  if (durationHours !== undefined) summary.durationHours = durationHours
  return summary
}

const resolveScenarioAssignmentNames = async (summaries: RealRouteScenarioSummary[]): Promise<RealRouteScenarioSummary[]> => {
  const driverIds = [...new Set(summaries.flatMap(({ driver, driverId }) =>
    driver === undefined && typeof driverId === 'string' && validId(driverId) ? [driverId.toLowerCase()] : []
  ))]
  const vehicleIds = [...new Set(summaries.flatMap(({ vehicle, vehicleId }) =>
    vehicle === undefined && typeof vehicleId === 'string' && validId(vehicleId) ? [vehicleId.toLowerCase()] : []
  ))]
  const [drivers, vehicles] = await Promise.all([
    driverIds.length === 0 ? Promise.resolve([]) : UserModel.find({ _id: { $in: driverIds.map((id) => new Types.ObjectId(id)) } }, { _id: 1, nickname: 1 }).lean(),
    vehicleIds.length === 0 ? Promise.resolve([]) : VehicleModel.find({ _id: { $in: vehicleIds.map((id) => new Types.ObjectId(id)) } }, { _id: 1, code: 1 }).lean()
  ])
  const driverNames = new Map(drivers.flatMap((driver) =>
    typeof driver.nickname === 'string' && driver.nickname.trim() !== '' ? [[String(driver._id).toLowerCase(), driver.nickname]] : []
  ))
  const vehicleCodes = new Map(vehicles.flatMap((vehicle) =>
    typeof vehicle.code === 'string' && vehicle.code.trim() !== '' ? [[String(vehicle._id).toLowerCase(), vehicle.code]] : []
  ))
  return summaries.map((summary) => ({
    ...summary,
    ...(summary.driver === undefined && summary.driverId !== undefined
      ? { driver: driverNames.get(summary.driverId.toLowerCase()) ?? summary.driverId }
      : {}),
    ...(summary.vehicle === undefined && summary.vehicleId !== undefined
      ? { vehicle: vehicleCodes.get(summary.vehicleId.toLowerCase()) ?? summary.vehicleId }
      : {})
  }))
}

class RealRouteScenarioError extends Error {}

const getRealRouteScenario = async (id: string, scope: RealRouteAccess): Promise<RealRouteScenario | null> => {
  validateRealRouteAccess(scope)
  if (!validId(id)) return null
  const scenario = await RouteSimulationModel.findById(new Types.ObjectId(id)).lean()
  if (scenario == null || !validId(scenario.routeId)) return null
  const routeId = new Types.ObjectId(scenario.routeId)
  const driverRoute = scope.kind === ACCESS_KIND.DRIVER
    ? (await getDriverSnapshots(scope.userId, { _id: routeId }, { _id: 1 }, 1))[0]
    : undefined
  const snapshot = scope.kind === ACCESS_KIND.DRIVER
    ? driverRoute?.snapshot ?? null
    : await RoutePlanModel.findById(routeId).lean()
  if (snapshot == null || String(snapshot._id).toLowerCase() !== scenario.routeId.toLowerCase()) return null
  const storedRouteSnapshot = isRecord(scenario.routeSnapshot) ? scenario.routeSnapshot as RealRouteScenarioSnapshot : {}
  const summary = routeScenarioSummary(scenario, snapshot, driverRoute?.projection?.assignments)
  const displaySummary = summary === null ? null : (await resolveScenarioAssignmentNames([summary]))[0]
  const routeSnapshot: RealRouteScenarioSnapshot = { ...storedRouteSnapshot }
  if (displaySummary !== null) {
    if (routeSnapshot.date === undefined && displaySummary.date !== undefined) routeSnapshot.date = new Date(displaySummary.date)
    if (routeSnapshot.zone === undefined && displaySummary.zone !== undefined) routeSnapshot.zone = displaySummary.zone
    if (routeSnapshot.driverId === undefined && displaySummary.driverId !== undefined) routeSnapshot.driverId = displaySummary.driverId
    if (routeSnapshot.driver === undefined && displaySummary.driver !== undefined) routeSnapshot.driver = displaySummary.driver
    if (routeSnapshot.vehicleId === undefined && displaySummary.vehicleId !== undefined) routeSnapshot.vehicleId = displaySummary.vehicleId
    if (routeSnapshot.vehicle === undefined && displaySummary.vehicle !== undefined) routeSnapshot.vehicle = displaySummary.vehicle
    if (routeSnapshot.orderCount === undefined && displaySummary.orderCount !== undefined) routeSnapshot.orderCount = displaySummary.orderCount
    if (routeSnapshot.distanceKm === undefined && displaySummary.distanceKm !== undefined) routeSnapshot.distanceKm = displaySummary.distanceKm
    if (routeSnapshot.fuelLiters === undefined && displaySummary.fuelLiters !== undefined) routeSnapshot.fuelLiters = displaySummary.fuelLiters
    if (routeSnapshot.durationHours === undefined && displaySummary.durationHours !== undefined) routeSnapshot.durationHours = displaySummary.durationHours
    if (routeSnapshot.saleIds === undefined && Array.isArray(snapshot.selectedSaleIds)) routeSnapshot.saleIds = [...snapshot.selectedSaleIds]
  }
  return { id: String(scenario._id), routeId: scenario.routeId, routeSnapshot, routeMetrics: scenario.routeMetrics, parameters: scenario.parameters, products: scenario.products, estimatedRevenue: scenario.estimatedRevenue, operatingCost: scenario.operatingCost, grossMargin: scenario.grossMargin }
}

const listRealRouteScenarios = async (page: number, scope: RealRouteAccess): Promise<RealRouteScenarioHistoryPage> => {
  validateRealRouteAccess(scope)
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('Invalid simulation page')

  const rawScenarios: unknown = await RouteSimulationModel.find({}).sort({ createdAt: -1, _id: -1 }).lean()
  if (!Array.isArray(rawScenarios)) throw new Error('Scenario history is unavailable')
  const scenarios = rawScenarios as StoredRealRouteScenario[]
  const routeIds = [...new Set(scenarios.map((scenario) => typeof scenario.routeId === 'string' && validId(scenario.routeId) ? scenario.routeId.toLowerCase() : undefined).filter((id): id is string => id !== undefined))]
  if (routeIds.length === 0) return { items: [], page, pageSize: ROUTE_SCENARIO_HISTORY_PAGE_SIZE, total: 0 }

  const objectIds = routeIds.map((id) => new Types.ObjectId(id))
  const snapshots: RoutePlan[] = []
  const effectiveAssignmentsById = new Map<string, RouteOperationalAssignment>()
  if (scope.kind === ACCESS_KIND.DRIVER) {
    const visible = await getDriverSnapshots(scope.userId, { _id: { $in: objectIds } }, { _id: -1 }, objectIds.length)
    snapshots.push(...visible.map(({ snapshot, projection }) => {
      if (projection?.assignments !== undefined) effectiveAssignmentsById.set(String(snapshot._id).toLowerCase(), projection.assignments)
      return snapshot
    }))
  } else {
    const rawSnapshots: unknown = await RoutePlanModel.find({ _id: { $in: objectIds } }).lean()
    if (Array.isArray(rawSnapshots)) snapshots.push(...rawSnapshots as RoutePlan[])
  }

  const snapshotsById = new Map(snapshots.map((snapshot) => [String(snapshot._id).toLowerCase(), snapshot]))
  const visibleSummaries = scenarios.flatMap((scenario) => {
    if (typeof scenario.routeId !== 'string' || !validId(scenario.routeId)) return []
    const snapshot = snapshotsById.get(scenario.routeId.toLowerCase())
    if (snapshot === undefined) return []
    const summary = routeScenarioSummary(scenario, snapshot, effectiveAssignmentsById.get(scenario.routeId.toLowerCase()))
    return summary === null ? [] : [summary]
  })
  const resolvedSummaries = await resolveScenarioAssignmentNames(visibleSummaries)
  const offset = page > Math.ceil(visibleSummaries.length / ROUTE_SCENARIO_HISTORY_PAGE_SIZE)
    ? visibleSummaries.length
    : (page - 1) * ROUTE_SCENARIO_HISTORY_PAGE_SIZE
  return {
    items: resolvedSummaries.slice(offset, offset + ROUTE_SCENARIO_HISTORY_PAGE_SIZE),
    page,
    pageSize: ROUTE_SCENARIO_HISTORY_PAGE_SIZE,
    total: visibleSummaries.length
  }
}

// Scope must be constructed by a trusted authorization guard, never from request input.
const createRealRouteScenario = async (input: RealRouteScenarioInput, scope: RealRouteAccess): Promise<RealRouteScenario> => {
  if (scope == null || typeof scope !== 'object') throw new Error('Invalid access scope')
  validateRealRouteAccess(scope)
  const driverId = scope.kind === ACCESS_KIND.DRIVER ? scope.userId : undefined
  const routeId = input?.routeId
  if (!validId(routeId)) throw new Error('Invalid route ID')
  const parameters = input.parameters == null ? input.parameters : { ...input.parameters }
  if (parameters == null || !nonNegative(parameters.fuelPricePerLiter) || !nonNegative(parameters.hourlyRate) ||
      !nonNegative(parameters.generalCosts) || typeof parameters.includeSurplus !== 'boolean' || !Array.isArray(input.products) || input.products.length > 10000) throw new Error('Invalid simulation input')
  const frozenParameters = Object.freeze({ fuelPricePerLiter: parameters.fuelPricePerLiter, hourlyRate: parameters.hourlyRate, generalCosts: parameters.generalCosts, includeSurplus: parameters.includeSurplus })
  const quantities = new Map<string, number>()
  for (const product of input.products) {
    const productId = product?.id
    const quantity = product?.quantity
    if (!validId(productId) || !nonNegative(quantity) || !Number.isSafeInteger(quantity)) throw new Error('Invalid simulation product')
    const normalizedId = productId.toLowerCase()
    const total = (quantities.get(normalizedId) ?? 0) + quantity
    if (!Number.isSafeInteger(total)) throw new Error('Invalid simulation product')
    quantities.set(normalizedId, total)
  }
  const selectedProducts = Object.freeze([...quantities].map(([id, quantity]) => Object.freeze({ id, quantity })))
  const id = new Types.ObjectId(routeId)
  const authorizedRoute = driverId === undefined
    ? undefined
    : (await getDriverSnapshots(driverId, { _id: id }, { _id: 1 }, 1))[0]
  const snapshot = driverId === undefined ? await RoutePlanModel.findById(id).lean() : authorizedRoute?.snapshot ?? null
  if (snapshot == null || String(snapshot._id).toLowerCase() !== routeId.toLowerCase()) throw new RealRouteScenarioError('Route not found or not visible')
  const projection = driverId === undefined
    ? await RoutePlanOperationalModel.findOne({ snapshotId: String(snapshot._id) }).lean()
    : authorizedRoute?.projection
  const metrics = snapshot.metrics
  if (metrics == null || !nonNegative(metrics.fuelLiters) || !nonNegative(metrics.durationSeconds)) throw new RealRouteScenarioError('Route metrics unavailable')
  const routeMetrics = { fuelLiters: metrics.fuelLiters, durationHours: metrics.durationSeconds / 3600 }
  const assignments = projection?.assignments ?? snapshot.assignments
  const driverAssignmentId = typeof assignments?.driverId === 'string' && assignments.driverId.trim() !== '' ? assignments.driverId : undefined
  const vehicleAssignmentId = typeof assignments?.vehicleId === 'string' && assignments.vehicleId.trim() !== '' ? assignments.vehicleId : undefined
  const driverObjectId = validId(driverAssignmentId) ? driverAssignmentId : undefined
  const vehicleObjectId = validId(vehicleAssignmentId) ? vehicleAssignmentId : undefined
  const [driverRecord, vehicleRecord] = await Promise.all([
    driverObjectId === undefined ? Promise.resolve(null) : UserModel.findById(driverObjectId).lean(),
    vehicleObjectId === undefined ? Promise.resolve(null) : VehicleModel.findById(vehicleObjectId).lean()
  ])
  const routeSnapshot: RealRouteScenarioSnapshot = {}
  if (snapshot.planningDate instanceof Date) routeSnapshot.date = snapshot.planningDate
  if (typeof snapshot.zoneSnapshot?.name === 'string' && snapshot.zoneSnapshot.name.trim() !== '') routeSnapshot.zone = snapshot.zoneSnapshot.name
  if (Array.isArray(snapshot.selectedSaleIds)) {
    routeSnapshot.saleIds = [...snapshot.selectedSaleIds]
    routeSnapshot.orderCount = snapshot.selectedSaleIds.length
  }
  if (nonNegative(metrics.distanceMeters)) routeSnapshot.distanceKm = metrics.distanceMeters / 1000
  routeSnapshot.fuelLiters = metrics.fuelLiters
  routeSnapshot.durationHours = routeMetrics.durationHours
  if (driverAssignmentId !== undefined) routeSnapshot.driverId = driverAssignmentId
  if (driverRecord !== null && typeof driverRecord.nickname === 'string' && driverRecord.nickname.trim() !== '') routeSnapshot.driver = driverRecord.nickname
  if (vehicleAssignmentId !== undefined) routeSnapshot.vehicleId = vehicleAssignmentId
  if (vehicleRecord !== null && typeof vehicleRecord.code === 'string' && vehicleRecord.code.trim() !== '') routeSnapshot.vehicle = vehicleRecord.code
  const records = await ProductModel.find({ _id: { $in: selectedProducts.map(({ id }) => new Types.ObjectId(id)) } }, { _id: 1, descripcion: 1, precioUnitario: 1, stock: 1 }).lean()
  const byId = new Map(records.map((record) => [String(record._id).toLowerCase(), record]))
  const products = selectedProducts.map(({ id, quantity }) => {
    const record = byId.get(id.toLowerCase())
    if (record == null || typeof record.descripcion !== 'string' || record.descripcion.trim() === '' || !nonNegative(record.precioUnitario)) throw new RealRouteScenarioError('Product or price unavailable')
    if (!nonNegative(record.stock) || quantity > record.stock) throw new RealRouteScenarioError('Product stock unavailable or insufficient')
    return { id: String(record._id), name: record.descripcion, unitPrice: record.precioUnitario, quantity, stock: record.stock }
  })
  const calculation = calculateDemoSimulation(routeMetrics, products, frozenParameters)
  if (!Object.values(calculation).every(Number.isFinite)) throw new RealRouteScenarioError('Simulation result is not finite')
  const scenario = { routeId: String(snapshot._id), routeSnapshot, routeMetrics, parameters: frozenParameters, products, ...calculation }
  const saved = await RouteSimulationModel.create(scenario)
  return { id: String(saved._id), ...scenario }
}

export { createRealRouteScenario, getRealRouteScenario, listRealRouteScenarios, listRouteCatalog, listRouteOptions, RealRouteScenarioError }
export type { RealRouteAccess, RouteOption }
