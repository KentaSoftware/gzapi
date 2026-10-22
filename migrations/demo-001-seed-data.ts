import { createHash } from 'crypto'
import mongoose, { Types } from 'mongoose'
import type { Document, UpdateFilter } from 'mongodb'

import {
  GEOCODING_PRECISION,
  GEOCODING_SOURCE,
  GEOCODING_STATUS
} from '../src/interfaces/client.interface'
import {
  DEFAULT_ROUTE_ALGORITHM,
  ROUTE_METRIC_AVAILABILITY,
  ROUTING_CONFIG_KEYS,
  ROUTE_MODES,
  type RouteLocation,
  type RouteMatrix,
  type RouteMatrixRequest,
  type RoutePlanSegment,
  type RoutePlanStop
} from '../src/interfaces/routeOptimization.interface'
import { SALE_DELIVERY_STATUS } from '../src/interfaces/sale.interface'
import { EXPENSE_TYPE, PAYMENT_METHOD, RELATED_KIND } from '../src/interfaces/expense.interface'
import type { GeocodingCandidate } from '../src/schemas/clientGeocoding'
import { geocode } from '../src/services/geocodingProvider'
import { computeMatrix, computeRoute } from '../src/services/routeMatrixProvider'

const DEFAULT_MONGO_URI = 'mongodb://127.0.0.1:27017/gzapi'
const FIXTURE_NAMESPACE = 'gzapi-demo-seed-v1'
const DEFAULT_SERVICE_DATE = '2026-10-14'
const SERVICE_TIME_ZONE = 'America/Argentina/Buenos_Aires'
const ROUTE_FUEL_CONSUMPTION = 8.5
const ROUTE_MAX_STOPS = 20

const FIXTURE_OUTCOME = {
  INSERTED: 'inserted',
  UPDATED: 'updated'
} as const

type FixtureOutcome = (typeof FIXTURE_OUTCOME)[keyof typeof FIXTURE_OUTCOME]

const DEMO_ADDRESS_SPECS = [
  {
    key: 'depot',
    name: 'GZ Demo Depot',
    address: 'Av. Mate de Luna 4100, San Miguel de Tucumán, Tucumán, Argentina'
  },
  {
    key: 'client:centro:1',
    name: 'GZ Demo Client Centro 1',
    address: '25 de Mayo 90, San Miguel de Tucumán, Tucumán, Argentina',
    zoneKey: 'centro'
  },
  {
    key: 'client:centro:2',
    name: 'GZ Demo Client Centro 2',
    address: 'San Martín 469, San Miguel de Tucumán, Tucumán, Argentina',
    zoneKey: 'centro'
  },
  {
    key: 'client:oeste:1',
    name: 'GZ Demo Client Oeste 1',
    address: 'Av. Sarmiento 655, San Miguel de Tucumán, Tucumán, Argentina',
    zoneKey: 'oeste'
  }
] as const

type DemoAddressKey = (typeof DEMO_ADDRESS_SPECS)[number]['key']

const DEMO_ZONES = [
  { key: 'centro', code: 'DEMO_CENTRO', name: 'Demo Centro' },
  { key: 'oeste', code: 'DEMO_OESTE', name: 'Demo Oeste' }
] as const

const DEMO_PRODUCT = {
  description: 'GZ Demo Route Product',
  purchasePrice: 75,
  salePrice: 120,
  barcode: 'GZ-DEMO-ROUTE-001'
} as const

const DEMO_VEHICLE = {
  code: 'GZ-DEMO-01',
  fuelConsumptionLitersPer100Km: ROUTE_FUEL_CONSUMPTION
} as const

const FINANCE_PERIODS = [
  { key: '2026-08', date: '2026-08-15T12:00:00.000Z', saleTotal: 18500, buyTotal: 9200, expenseCents: 175000 },
  { key: '2026-09', date: '2026-09-15T12:00:00.000Z', saleTotal: 22400, buyTotal: 10800, expenseCents: 210000 },
  { key: '2026-10', date: '2026-10-10T12:00:00.000Z', saleTotal: 26750, buyTotal: 12400, expenseCents: 235000 }
] as const

interface DemoTarget {
  uri: string
  database: string
  remote: boolean
}

interface DemoArguments {
  dryRun: boolean
  confirmRemote: boolean
  target: DemoTarget
}

interface WriteResult {
  upsertedCount: number
  modifiedCount: number
}

export interface FixtureCollection {
  findOne: (filter: Record<string, unknown>) => Promise<unknown>
  updateOne: (
    filter: Record<string, unknown>,
    update: FixtureUpdate,
    options: { upsert: true }
  ) => Promise<WriteResult>
}

interface FixtureUpdate {
  $set: Record<string, unknown>
  $setOnInsert: Record<string, unknown>
}

export interface DemoDatabase {
  collection: (name: string) => FixtureCollection
}

interface DemoProviders {
  geocoder: (input: { address: string }) => Promise<GeocodingCandidate[]>
  matrix: (input: RouteMatrixRequest) => Promise<RouteMatrix>
  route: typeof computeRoute
}

interface GeocodedLocation extends RouteLocation {
  key: DemoAddressKey
  requestedAddress: string
  formattedAddress: string
  placeId: string
  precision: GeocodingCandidate['precision']
}

interface PreparedSnapshot {
  zoneKey: string
  zoneCode: string
  zoneName: string
  clients: GeocodedLocation[]
  route: Awaited<ReturnType<typeof computeRoute>>
  segments: RoutePlanSegment[]
}

interface DemoSummary {
  inserted: number
  updated: number
  collections: Record<string, number>
}

export interface DemoSeedResult {
  dryRun: boolean
  target: Pick<DemoTarget, 'database' | 'remote'>
  addressCount: number
  summary?: DemoSummary
}

const fixtureObjectId = (key: string): Types.ObjectId => new Types.ObjectId(
  createHash('sha256').update(`${FIXTURE_NAMESPACE}:${key}`).digest('hex').slice(0, 24)
)

const isLocalHost = (hostname: string): boolean => ['localhost', '127.0.0.1', '::1'].includes(hostname.toLowerCase())

export const resolveTarget = (uri: string, confirmRemote: boolean): DemoTarget => {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    throw new Error('MONGODB_URI is not a valid MongoDB connection string')
  }

  const isMongoProtocol = parsed.protocol === 'mongodb:' || parsed.protocol === 'mongodb+srv:'
  if (!isMongoProtocol || parsed.hostname === '') throw new Error('MONGODB_URI must use the MongoDB protocol')

  const remote = !isLocalHost(parsed.hostname)
  if (remote && !confirmRemote) throw new Error('Remote targets require the explicit --confirm-remote flag')

  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
  return {
    uri,
    database: database === '' ? '(default)' : database,
    remote
  }
}

export const parseDemoArguments = (
  argv: string[],
  environment: Record<string, string | undefined> = process.env
): DemoArguments => {
  let dryRun = false
  let confirmRemote = false
  for (const argument of argv) {
    if (argument === '--dry-run') {
      dryRun = true
    } else if (argument === '--confirm-remote') {
      confirmRemote = true
    } else {
      throw new Error(`Unexpected argument ${argument}`)
    }
  }

  const configuredUri = environment.MONGODB_URI
  const uri = configuredUri === undefined || configuredUri.trim() === '' ? DEFAULT_MONGO_URI : configuredUri.trim()
  return { dryRun, confirmRemote, target: resolveTarget(uri, confirmRemote) }
}

export const selectRoadSafeCandidate = (
  candidates: GeocodingCandidate[],
  address: string
): GeocodingCandidate => {
  if (candidates.length !== 1) throw new Error(`Geocoding for ${address} was empty or ambiguous`)
  const candidate = candidates[0]
  if (candidate.precision !== GEOCODING_PRECISION.ROOFTOP && candidate.precision !== GEOCODING_PRECISION.RANGE_INTERPOLATED) {
    throw new Error(`Geocoding for ${address} did not return a road-safe precision`)
  }
  return candidate
}

export const validateRoadConnectivity = async (
  depot: RouteLocation,
  clients: RouteLocation[],
  matrix: DemoProviders['matrix']
): Promise<RouteMatrix> => {
  const locations = [depot, ...clients]
  const result = await matrix({ origins: locations, destinations: locations })
  const segments = new Set(result.segments.map((segment) => `${segment.fromId}\u0000${segment.toId}`))
  for (const origin of locations) {
    for (const destination of locations) {
      if (origin.id === destination.id) continue
      if (!segments.has(`${origin.id}\u0000${destination.id}`)) {
        throw new Error('Google Routes could not prove a DRIVE route between demo locations')
      }
    }
  }
  return result
}

export const upsertFixture = async (
  collection: FixtureCollection,
  key: string,
  id: Types.ObjectId,
  payload: Record<string, unknown>,
  now: Date
): Promise<FixtureOutcome> => {
  const result = await collection.updateOne(
    { _id: id, fixtureNamespace: FIXTURE_NAMESPACE, fixtureKey: key },
    {
      $set: { ...payload, fixtureNamespace: FIXTURE_NAMESPACE, fixtureKey: key, updatedAt: now },
      $setOnInsert: { _id: id, createdAt: now }
    },
    { upsert: true }
  )
  return result.upsertedCount > 0 ? FIXTURE_OUTCOME.INSERTED : FIXTURE_OUTCOME.UPDATED
}

const createSummary = (): DemoSummary => ({ inserted: 0, updated: 0, collections: {} })

const recordOutcome = (summary: DemoSummary, collection: string, outcome: FixtureOutcome): void => {
  summary[outcome] += 1
  summary.collections[collection] = (summary.collections[collection] ?? 0) + 1
}

const resolveServiceDate = (value: string | undefined): Date => {
  const serviceDate = value === undefined || value.trim() === '' ? DEFAULT_SERVICE_DATE : value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) throw new Error('DEMO_SERVICE_DATE must be a YYYY-MM-DD date')
  const date = new Date(`${serviceDate}T00:00:00.000Z`)
  const [year, month, day] = serviceDate.split('-').map(Number)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error('DEMO_SERVICE_DATE must be a real calendar date')
  }
  return date
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

const readAdminId = async (database: DemoDatabase): Promise<Types.ObjectId> => {
  const admin = asRecord(await database.collection('users').findOne({ nickname: 'admin' }))
  const value = admin?._id
  if (value instanceof Types.ObjectId) return value
  if (typeof value === 'string' && Types.ObjectId.isValid(value)) return new Types.ObjectId(value)
  throw new Error('The base admin user is required before running the demo seed')
}

const geocodeLocation = async (
  spec: (typeof DEMO_ADDRESS_SPECS)[number],
  geocoder: DemoProviders['geocoder']
): Promise<GeocodedLocation> => {
  const candidate = selectRoadSafeCandidate(await geocoder({ address: spec.address }), spec.address)
  return {
    id: spec.key,
    key: spec.key,
    name: spec.name,
    latitude: candidate.lat,
    longitude: candidate.lng,
    requestedAddress: spec.address,
    formattedAddress: candidate.formattedAddress,
    placeId: candidate.placeId,
    precision: candidate.precision
  }
}

const routeSegmentsFor = (
  depot: RouteLocation,
  clients: GeocodedLocation[],
  matrix: RouteMatrix
): RoutePlanSegment[] => {
  const points = [depot, ...clients, depot]
  return points.slice(0, -1).map((from, index) => {
    const to = points[index + 1]
    const segment = matrix.segments.find((candidate) => candidate.fromId === from.id && candidate.toId === to.id)
    if (segment === undefined) throw new Error('Google Routes matrix did not contain the planned route segment')
    return {
      fromStopSequence: index === 0 ? 0 : index,
      toStopSequence: index === points.length - 2 ? 0 : index + 1,
      distanceMeters: segment.distanceMeters,
      durationSeconds: segment.durationSeconds
    }
  })
}

const prepareSeed = async (
  providers: DemoProviders
): Promise<{ depot: GeocodedLocation, clients: GeocodedLocation[], snapshots: PreparedSnapshot[] }> => {
  const depot = await geocodeLocation(DEMO_ADDRESS_SPECS[0], providers.geocoder)
  const clients = await Promise.all(DEMO_ADDRESS_SPECS.slice(1).map(async (spec) => await geocodeLocation(spec, providers.geocoder)))
  const matrix = await validateRoadConnectivity(depot, clients, providers.matrix)
  const snapshots: PreparedSnapshot[] = []

  for (const zone of DEMO_ZONES) {
    const zoneClients = clients.filter((client) => client.key.startsWith(`client:${zone.key}:`))
    const route = await providers.route({ origin: depot, intermediates: zoneClients, destination: depot })
    snapshots.push({
      zoneKey: zone.key,
      zoneCode: zone.code,
      zoneName: zone.name,
      clients: zoneClients,
      route,
      segments: routeSegmentsFor(depot, zoneClients, matrix)
    })
  }

  return { depot, clients, snapshots }
}

const geocodingDocument = (location: GeocodedLocation, validatedAt: Date, validatedBy: Types.ObjectId): Record<string, unknown> => ({
  status: GEOCODING_STATUS.CONFIRMED,
  source: GEOCODING_SOURCE.GEOCODED,
  formattedAddress: location.formattedAddress,
  placeId: location.placeId,
  precision: location.precision,
  validatedAt,
  validatedBy
})

const locationDocument = (location: GeocodedLocation, validatedAt: Date, validatedBy: Types.ObjectId): Record<string, unknown> => ({
  nombreCompleto: location.name,
  address: location.formattedAddress,
  telefonos: [3815000000 + Math.abs(location.key.length)],
  lat: location.latitude,
  lng: location.longitude,
  isActive: true,
  geocoding: geocodingDocument(location, validatedAt, validatedBy)
})

const buildSnapshot = (
  snapshot: PreparedSnapshot,
  depot: GeocodedLocation,
  serviceDate: Date,
  userId: Types.ObjectId,
  vehicleId: Types.ObjectId,
  saleIds: string[]
): Record<string, unknown> => {
  const stops: RoutePlanStop[] = snapshot.clients.map((client, index) => ({
    clientId: client.id,
    saleIds: [saleIds[index]],
    sequence: index + 1,
    latitude: client.latitude,
    longitude: client.longitude
  }))
  let cumulativeDurationSeconds = 0
  const stopEstimates = snapshot.segments.slice(0, -1).map((segment, index) => {
    cumulativeDurationSeconds += segment.durationSeconds + 180
    return {
      sequence: index + 1,
      arrival: new Date(serviceDate.getTime() + cumulativeDurationSeconds * 1000),
      cumulativeDurationSeconds,
      calculatedAt: serviceDate,
      timezone: SERVICE_TIME_ZONE,
      availability: ROUTE_METRIC_AVAILABILITY.CALCULATED
    }
  })
  const distanceKm = snapshot.route.distanceMeters / 1000
  return {
    snapshotVersion: 1,
    planningDate: serviceDate,
    zoneSnapshot: { code: snapshot.zoneCode, normalizedName: snapshot.zoneKey, name: snapshot.zoneName },
    selectedSaleIds: saleIds,
    depot: {
      id: depot.id,
      name: depot.name,
      latitude: depot.latitude,
      longitude: depot.longitude,
      address: depot.formattedAddress,
      geocoding: {
        status: GEOCODING_STATUS.CONFIRMED,
        source: GEOCODING_SOURCE.GEOCODED,
        formattedAddress: depot.formattedAddress,
        placeId: depot.placeId,
        precision: depot.precision
      }
    },
    stops,
    segments: snapshot.segments,
    metrics: {
      distanceMeters: snapshot.route.distanceMeters,
      durationSeconds: snapshot.route.durationSeconds + snapshot.clients.length * 180,
      stopCount: stops.length,
      fuelLiters: distanceKm * ROUTE_FUEL_CONSUMPTION / 100,
      availability: ROUTE_METRIC_AVAILABILITY.CALCULATED
    },
    algorithm: { name: DEFAULT_ROUTE_ALGORITHM, version: DEFAULT_ROUTE_ALGORITHM, provider: ROUTE_MODES.GOOGLE_ROUTES },
    routingConfigRevision: 1,
    ruleVersion: 'candidate-eligibility-v1',
    encodedPolyline: snapshot.route.encodedPolyline,
    warnings: [],
    audit: { createdBy: String(userId), createdAt: serviceDate },
    assignments: { driverId: String(userId), vehicleId: String(vehicleId) },
    fuelAssumptions: {
      availability: ROUTE_METRIC_AVAILABILITY.CALCULATED,
      consumptionLitersPer100Km: ROUTE_FUEL_CONSUMPTION,
      distanceKm,
      vehicleCode: DEMO_VEHICLE.code,
      source: 'google-routes',
      calculatedAt: serviceDate
    },
    scheduleAssumptions: { calculatedAt: serviceDate, timezone: SERVICE_TIME_ZONE, source: 'google-routes' },
    stopEstimates,
    saleReferences: saleIds.map((saleId) => ({ saleId, versionAtSave: null, statusAtSave: SALE_DELIVERY_STATUS.PENDING }))
  }
}

const seedPreparedData = async (
  database: DemoDatabase,
  prepared: Awaited<ReturnType<typeof prepareSeed>>,
  serviceDate: Date,
  now: Date
): Promise<DemoSummary> => {
  const summary = createSummary()
  const adminId = await readAdminId(database)
  const write = async (collectionName: string, key: string, id: Types.ObjectId, payload: Record<string, unknown>): Promise<void> => {
    recordOutcome(summary, collectionName, await upsertFixture(database.collection(collectionName), key, id, payload, now))
  }

  const categoryId = fixtureObjectId('catalog:category')
  const brandId = fixtureObjectId('catalog:brand')
  const providerId = fixtureObjectId('catalog:provider')
  const productId = fixtureObjectId('catalog:product')
  await write('categories', 'catalog:category', categoryId, { descripcion: 'GZ Demo Catalog' })
  await write('brands', 'catalog:brand', brandId, { descripcion: 'GZ Demo Brand' })
  await write('providers', 'catalog:provider', providerId, { descripcion: 'GZ Demo Supplier' })
  await write('products', 'catalog:product', productId, {
    descripcion: DEMO_PRODUCT.description,
    stock: 500,
    codigoBarra: DEMO_PRODUCT.barcode,
    precioCompra: DEMO_PRODUCT.purchasePrice,
    precioUnitario: DEMO_PRODUCT.salePrice,
    categoria: categoryId,
    marca: brandId,
    proveedor: providerId
  })

  const zoneIds = new Map<string, Types.ObjectId>()
  for (const zone of DEMO_ZONES) {
    const id = fixtureObjectId(`zone:${zone.key}`)
    zoneIds.set(zone.key, id)
    await write('deliveryzones', `zone:${zone.key}`, id, { code: zone.code, name: zone.name, normalizedName: zone.key, active: true })
  }

  const clientIds = new Map<string, Types.ObjectId>()
  for (const client of prepared.clients) {
    const id = fixtureObjectId(client.key)
    clientIds.set(client.key, id)
    const zoneKey = client.key.split(':')[1]
    const zoneId = zoneIds.get(zoneKey)
    if (zoneId === undefined) throw new Error('Demo client zone is not configured')
    await write('clients', client.key, id, { ...locationDocument(client, now, adminId), deliveryZoneId: zoneId })
  }

  const vehicleId = fixtureObjectId('vehicle:primary')
  await write('vehicles', 'vehicle:primary', vehicleId, {
    code: DEMO_VEHICLE.code,
    fuelConsumptionLitersPer100Km: DEMO_VEHICLE.fuelConsumptionLitersPer100Km,
    attributes: { fixture: FIXTURE_NAMESPACE, capacity: 'demo' },
    active: true
  })

  const depot = prepared.depot
  await write('routingconfigs', 'routing-config:depot', fixtureObjectId('routing-config:depot'), {
    key: ROUTING_CONFIG_KEYS.DEPOSITO_1,
    enabled: true,
    revision: 1,
    depot: {
      name: depot.name,
      latitude: depot.latitude,
      longitude: depot.longitude,
      address: depot.formattedAddress,
      geocoding: {
        status: GEOCODING_STATUS.CONFIRMED,
        source: GEOCODING_SOURCE.GEOCODED,
        formattedAddress: depot.formattedAddress,
        placeId: depot.placeId,
        precision: depot.precision
      }
    },
    fuelConsumptionLitersPer100Km: ROUTE_FUEL_CONSUMPTION,
    maxStops: ROUTE_MAX_STOPS,
    provider: ROUTE_MODES.GOOGLE_ROUTES,
    algorithm: DEFAULT_ROUTE_ALGORITHM,
    updatedBy: adminId
  })

  const routeSaleIds = new Map<string, Types.ObjectId>()
  for (const client of prepared.clients) {
    const clientId = clientIds.get(client.key)
    if (clientId === undefined) throw new Error('Demo client identifier is missing')
    const saleId = fixtureObjectId(`route-sale:${client.key}`)
    routeSaleIds.set(client.key, saleId)
    const quantity = client.key.endsWith(':1') ? 2 : 1
    await write('sales', `route-sale:${client.key}`, saleId, {
      estado: 'CREATED',
      total: quantity * DEMO_PRODUCT.salePrice,
      user: adminId,
      cliente: client.name,
      idCliente: clientId,
      delivery: { status: SALE_DELIVERY_STATUS.PENDING, serviceDate }
    })
    await write('itemsales', `route-item-sale:${client.key}`, fixtureObjectId(`route-item-sale:${client.key}`), {
      idVenta: saleId,
      idProducto: productId,
      cantidad: quantity,
      total: quantity * DEMO_PRODUCT.salePrice,
      estado: true,
      precioUnitario: DEMO_PRODUCT.salePrice
    })
  }

  for (const snapshot of prepared.snapshots) {
    const saleIds = snapshot.clients.map((client) => String(routeSaleIds.get(client.key)))
    await write('routeplans', `route-snapshot:${snapshot.zoneKey}`, fixtureObjectId(`route-snapshot:${snapshot.zoneKey}`), buildSnapshot(snapshot, depot, serviceDate, adminId, vehicleId, saleIds))
  }

  for (let index = 0; index < FINANCE_PERIODS.length; index += 1) {
    const period = FINANCE_PERIODS[index]
    const client = prepared.clients[index % prepared.clients.length]
    const clientId = clientIds.get(client.key)
    if (clientId === undefined) throw new Error('Finance fixture client identifier is missing')
    const date = new Date(period.date)
    const saleId = fixtureObjectId(`finance:sale:${period.key}`)
    await write('sales', `finance:sale:${period.key}`, saleId, {
      estado: 'COMPLETED',
      total: period.saleTotal,
      user: adminId,
      cliente: client.name,
      idCliente: clientId,
      paidAt: date,
      createdAt: date,
      delivery: { status: SALE_DELIVERY_STATUS.DELIVERED, deliveredAt: date }
    })
    await write('itemsales', `finance:item-sale:${period.key}`, fixtureObjectId(`finance:item-sale:${period.key}`), {
      idVenta: saleId,
      idProducto: productId,
      cantidad: 10,
      total: period.saleTotal,
      estado: true,
      precioUnitario: period.saleTotal / 10
    })

    const buyId = fixtureObjectId(`finance:buy:${period.key}`)
    await write('buys', `finance:buy:${period.key}`, buyId, {
      estado: 'paid',
      total: period.buyTotal,
      user: adminId,
      proveedor: 'GZ Demo Supplier',
      fecha: date,
      paidAt: date,
      createdAt: date,
      docNumber: `GZ-DEMO-${period.key}`
    })
    await write('itembuys', `finance:item-buy:${period.key}`, fixtureObjectId(`finance:item-buy:${period.key}`), {
      idBuy: buyId,
      idProducto: productId,
      cantidad: 10,
      total: period.buyTotal,
      precio: period.buyTotal / 10,
      estado: true
    })

    await write('expenses', `finance:expense:${period.key}`, fixtureObjectId(`finance:expense:${period.key}`), {
      date,
      amountCents: period.expenseCents,
      currency: 'ARS',
      category: 'Demo operations',
      type: EXPENSE_TYPE.OPERATIVO,
      paymentMethod: PAYMENT_METHOD.TRANSFERENCIA,
      description: `GZ demo operating expense ${period.key}`,
      relatedTo: { kind: RELATED_KIND.NONE },
      createdBy: adminId,
      isDeleted: false
    })
  }

  await write('cashflowconfigs', 'finance:cashflow-config', fixtureObjectId('finance:cashflow-config'), {
    openingBalance: 100000,
    reserveMonthsMultiplier: 1,
    deficitAlertEnabled: true,
    idleCapitalRecommendMin: 25000
  })
  return summary
}

export const runDemoSeed = async (input: {
  target: DemoTarget
  dryRun: boolean
  database?: DemoDatabase
  providers?: DemoProviders
  serviceDate?: Date
  now?: Date
}): Promise<DemoSeedResult> => {
  if (input.dryRun) {
    return { dryRun: true, target: { database: input.target.database, remote: input.target.remote }, addressCount: DEMO_ADDRESS_SPECS.length }
  }
  if (input.database === undefined || input.providers === undefined) throw new Error('Demo seed dependencies are not configured')
  const serviceDate = input.serviceDate ?? resolveServiceDate(undefined)
  const prepared = await prepareSeed(input.providers)
  const summary = await seedPreparedData(input.database, prepared, serviceDate, input.now ?? new Date())
  return { dryRun: false, target: { database: input.target.database, remote: input.target.remote }, addressCount: DEMO_ADDRESS_SPECS.length, summary }
}

const mongoDatabase = (): DemoDatabase => {
  const database = mongoose.connection.db
  if (database === undefined) throw new Error('MongoDB connection did not expose a database')
  return {
    collection: (name: string): FixtureCollection => {
      const collection = database.collection(name)
      return {
        findOne: async (filter) => await collection.findOne(filter as Document),
        updateOne: async (filter, update, options) => {
          const result = await collection.updateOne(filter as Document, update as unknown as UpdateFilter<Document>, options)
          return { upsertedCount: result.upsertedCount, modifiedCount: result.modifiedCount }
        }
      }
    }
  }
}

const printResult = (result: DemoSeedResult): void => {
  if (result.dryRun) {
    process.stdout.write(`Demo seed dry run: ${result.addressCount} provider-resolved addresses planned for ${result.target.remote ? 'remote' : 'local'} database ${result.target.database}\n`)
    process.stdout.write('No database connection, geocoding request, or write was performed.\n')
    return
  }
  process.stdout.write(`Demo seed completed for ${result.target.remote ? 'remote' : 'local'} database ${result.target.database}\n`)
  process.stdout.write(`Fixtures: ${result.summary?.inserted ?? 0} inserted, ${result.summary?.updated ?? 0} updated\n`)
}

const safeErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : 'Demo seed failed'
  return message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, '[redacted MongoDB target]')
}

const main = async (): Promise<void> => {
  const args = parseDemoArguments(process.argv.slice(2))
  if (args.dryRun) {
    printResult(await runDemoSeed({ target: args.target, dryRun: true }))
    return
  }
  await mongoose.connect(args.target.uri)
  try {
    const result = await runDemoSeed({
      target: args.target,
      dryRun: false,
      database: mongoDatabase(),
      providers: { geocoder: geocode, matrix: computeMatrix, route: computeRoute },
      serviceDate: resolveServiceDate(process.env.DEMO_SERVICE_DATE)
    })
    printResult(result)
  } finally {
    await mongoose.disconnect()
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${safeErrorMessage(error)}\n`)
    process.exitCode = 1
  })
}

export { DEMO_ADDRESS_SPECS, FIXTURE_NAMESPACE }
