import RoutePlanModel from '../models/routePlan'
import RoutePlanOperationalModel from '../models/routePlanOperational'
import type { RoutePlan, RoutePlanOperational, RouteOperationalAssignment } from '../interfaces/routeOptimization.interface'
import { getDriverSnapshots, MAX_SNAPSHOT_LIST_READS } from './routePlan'
import { Types } from 'mongoose'
import ProductModel from '../models/product'
import RouteSimulationModel from '../models/routeSimulation'
import { calculateDemoSimulation } from './simulationCalculation'
import type { SimulationDemoRunInput } from './simulation'

interface RouteOption {
  _id: string
  planningDate: Date
  zoneSnapshot: RoutePlan['zoneSnapshot']
  metrics: RoutePlan['metrics']
  assignments: RouteOperationalAssignment | null
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
  const items = entries.slice(0, MAX_SNAPSHOT_LIST_READS).map(({ snapshot, projection }) => ({
    _id: String(snapshot._id),
    planningDate: snapshot.planningDate,
    zoneSnapshot: snapshot.zoneSnapshot,
    metrics: snapshot.metrics,
    assignments: projection !== undefined ? projection.assignments : snapshot.assignments ?? null
  }))
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

const nonNegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id)

class RealRouteScenarioError extends Error {}

const getRealRouteScenario = async (id: string, scope: RealRouteAccess): Promise<RealRouteScenario | null> => {
  if (scope == null || (scope.kind !== ACCESS_KIND.GLOBAL && scope.kind !== ACCESS_KIND.DRIVER) ||
      (scope.kind === ACCESS_KIND.DRIVER && (typeof scope.userId !== 'string' || scope.userId.trim() === ''))) throw new Error('Invalid access scope')
  if (!validId(id)) return null
  const scenario = await RouteSimulationModel.findById(new Types.ObjectId(id)).lean()
  if (scenario == null || !validId(scenario.routeId)) return null
  const routeId = new Types.ObjectId(scenario.routeId)
  const snapshot = scope.kind === ACCESS_KIND.DRIVER
    ? (await getDriverSnapshots(scope.userId, { _id: routeId }, { _id: 1 }, 1))[0]?.snapshot ?? null
    : await RoutePlanModel.findById(routeId).lean()
  if (snapshot == null || String(snapshot._id).toLowerCase() !== scenario.routeId.toLowerCase()) return null
  return { id: String(scenario._id), routeId: scenario.routeId, routeMetrics: scenario.routeMetrics, parameters: scenario.parameters, products: scenario.products, estimatedRevenue: scenario.estimatedRevenue, operatingCost: scenario.operatingCost, grossMargin: scenario.grossMargin }
}

// Scope must be constructed by a trusted authorization guard, never from request input.
const createRealRouteScenario = async (input: RealRouteScenarioInput, scope: RealRouteAccess): Promise<RealRouteScenario> => {
  if (scope == null || typeof scope !== 'object' ||
      (scope.kind !== ACCESS_KIND.GLOBAL && scope.kind !== ACCESS_KIND.DRIVER) ||
      (scope.kind === ACCESS_KIND.DRIVER && (typeof scope.userId !== 'string' || scope.userId.trim() === ''))) throw new Error('Invalid access scope')
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
  const snapshot = driverId === undefined
    ? await RoutePlanModel.findById(id).lean()
    : (await getDriverSnapshots(driverId, { _id: id }, { _id: 1 }, 1))[0]?.snapshot ?? null
  if (snapshot == null || String(snapshot._id).toLowerCase() !== routeId.toLowerCase()) throw new RealRouteScenarioError('Route not found or not visible')
  const metrics = snapshot.metrics
  if (metrics == null || !nonNegative(metrics.fuelLiters) || !nonNegative(metrics.durationSeconds)) throw new RealRouteScenarioError('Route metrics unavailable')
  const routeMetrics = { fuelLiters: metrics.fuelLiters, durationHours: metrics.durationSeconds / 3600 }
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
  const scenario = { routeId: String(snapshot._id), routeMetrics, parameters: frozenParameters, products, ...calculation }
  const saved = await RouteSimulationModel.create(scenario)
  return { id: String(saved._id), ...scenario }
}

export { createRealRouteScenario, getRealRouteScenario, listRouteCatalog, listRouteOptions, RealRouteScenarioError }
export type { RealRouteAccess, RouteOption }
