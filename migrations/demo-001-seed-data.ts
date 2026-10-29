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
const SERVICE_TIME_ZONE = 'America/Argentina/Buenos_Aires'
const ROUTE_FUEL_CONSUMPTION = 8.5
const ROUTE_MAX_STOPS = 20

const FIXTURE_OUTCOME = {
  INSERTED: 'inserted',
  UPDATED: 'updated'
} as const

type FixtureOutcome = (typeof FIXTURE_OUTCOME)[keyof typeof FIXTURE_OUTCOME]

// Additional street numbers are published at https://www.cgcetucuman.org.ar/sucursales-rapipago/
// They are candidates only; Google precision and complete DRIVE coverage gate every write.
const DEMO_ADDRESS_SPECS = [
  {
    key: 'depot',
    name: 'GZ Demo Depot',
    address: 'Av. Mate de Luna 4357, San Miguel de Tucumán, Tucumán, Argentina'
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
  },
  ...[
    ['centro', 3, 'Batalla de Chacabuco 85'],
    ['centro', 4, 'Santiago del Estero 455'],
    ['centro', 5, 'Córdoba 560'],
    ['centro', 6, '25 de Mayo 319'],
    ['centro', 7, 'Rivadavia 88'],
    ['centro', 8, 'San Martín 853'],
    ['oeste', 2, 'Av. Belgrano 1716'],
    ['oeste', 3, 'Av. Belgrano 2755'],
    ['oeste', 4, 'Av. Belgrano 3300'],
    ['oeste', 5, 'Av. Roca 3057'],
    ['oeste', 6, 'Av. Roca 3450'],
    ['oeste', 7, 'Av. Roca 250'],
    ['sur', 1, 'Entre Ríos 130'],
    ['sur', 2, 'Congreso 514'],
    ['sur', 3, 'Gral. Paz 523'],
    ['sur', 4, 'Jujuy 108'],
    ['sur', 5, 'Crisóstomo Álvarez 464']
  ].map(([zone, number, street]) => ({
    key: `client:${zone}:${number}`,
    name: `GZ Demo Client ${zone} ${number}`,
    address: `${street}, San Miguel de Tucumán, Tucumán, Argentina`,
    zoneKey: zone
  }))
] as Array<{ key: string, name: string, address: string, zoneKey?: string }>

// Coordinates read from the Google Maps place pin for each address (fixed, reviewed input).
// They replace Geocoding at seed time; Google Routes still computes the route metrics.
const MANUAL_DEMO_COORDINATES: Record<string, { lat: number, lng: number }> = {
  depot: { lat: -26.8193761, lng: -65.2589428 },
  'client:centro:1': { lat: -26.8300928, lng: -65.205013 },
  'client:centro:2': { lat: -26.8510626, lng: -65.2822725 },
  'client:oeste:1': { lat: -26.8177266, lng: -65.2039054 },
  'client:centro:3': { lat: -26.831372, lng: -65.2081626 },
  'client:centro:4': { lat: -26.8242071, lng: -65.2025614 },
  'client:centro:5': { lat: -26.8270052, lng: -65.204575 },
  'client:centro:6': { lat: -26.826721, lng: -65.2034004 },
  'client:centro:7': { lat: -26.830523, lng: -65.201654 },
  'client:centro:8': { lat: -26.8284282, lng: -65.2097925 },
  'client:oeste:2': { lat: -26.8152191, lng: -65.2201069 },
  'client:oeste:3': { lat: -26.8116916, lng: -65.2360334 },
  'client:oeste:4': { lat: -26.8105456, lng: -65.2433294 },
  'client:oeste:5': { lat: -26.834853, lng: -65.2479649 },
  'client:oeste:6': { lat: -26.8349324, lng: -65.2525064 },
  'client:oeste:7': { lat: -26.844133, lng: -65.2040087 },
  'client:sur:1': { lat: -26.8338055, lng: -65.2004494 },
  'client:sur:2': { lat: -26.8383777, lng: -65.2047655 },
  'client:sur:3': { lat: -26.8359667, lng: -65.2071356 },
  'client:sur:4': { lat: -26.8311755, lng: -65.2110757 },
  'client:sur:5': { lat: -26.8325424, lng: -65.204391 }
}

type DemoAddressKey = (typeof DEMO_ADDRESS_SPECS)[number]['key']

const DEMO_ZONES = [
  { key: 'centro', code: 'DEMO_CENTRO', name: 'Demo Centro' },
  { key: 'oeste', code: 'DEMO_OESTE', name: 'Demo Oeste' },
  { key: 'sur', code: 'DEMO_SUR', name: 'Demo Sur' }
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

const LEGACY_FINANCE_TOTALS = [
  { saleTotal: 15800, buyTotal: 7200, expenseCents: 130000 },
  { saleTotal: 16900, buyTotal: 7900, expenseCents: 145000 },
  { saleTotal: 17400, buyTotal: 8500, expenseCents: 155000 },
  { saleTotal: 18500, buyTotal: 9200, expenseCents: 175000 },
  { saleTotal: 22400, buyTotal: 10800, expenseCents: 210000 },
  { saleTotal: 26750, buyTotal: 12400, expenseCents: 235000 }
] as const

const DEMO_CATEGORIES = ['Beverages', 'Groceries', 'Cleaning', 'Personal care', 'Snacks', 'Pantry'] as const
const DEMO_BRANDS = ['Andes', 'Norte', 'Pampa', 'Sol', 'Rio', 'Valle', 'Campo', 'Luna'] as const
const DEMO_PROVIDERS = ['North Distribution', 'Regional Supply', 'Valley Wholesale', 'River Trading', 'Central Goods'] as const
const DEMO_VARIANTS = ['Classic', 'Family', 'Compact', 'Premium', 'Economy', 'Fresh', 'Large', 'Small', 'Original', 'Select', 'Daily', 'Special', 'Light', 'Extra'] as const

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
    options: { upsert: boolean }
  ) => Promise<WriteResult>
}

interface FixtureUpdate {
  $set?: Record<string, unknown>
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

const ownedFixtureKeys = (serviceDate: Date): Array<{ collection: string, key: string }> => {
  const keys: Array<{ collection: string, key: string }> = []
  const add = (collection: string, key: string): void => { keys.push({ collection, key }) }
  for (const collection of ['categories', 'brands', 'providers', 'products']) {
    add(collection, `catalog:${collection === 'categories' ? 'category' : collection === 'brands' ? 'brand' : collection === 'providers' ? 'provider' : 'product'}`)
  }
  for (const [collection, prefix, count] of [
    ['categories', 'category', DEMO_CATEGORIES.length],
    ['brands', 'brand', DEMO_BRANDS.length],
    ['providers', 'provider', DEMO_PROVIDERS.length]
  ] as const) {
    for (let index = 1; index <= count; index += 1) add(collection, `catalog:${prefix}:${index}`)
  }
  for (let category = 1; category <= DEMO_CATEGORIES.length; category += 1) {
    for (let variant = 1; variant <= DEMO_VARIANTS.length; variant += 1) add('products', `catalog:product:${category}:${variant}`)
  }
  for (const zone of DEMO_ZONES) add('deliveryzones', `zone:${zone.key}`)
  for (const client of DEMO_ADDRESS_SPECS.slice(1)) {
    add('clients', client.key)
    add('sales', `route-sale:${client.key}`)
    add('itemsales', `route-item-sale:${client.key}`)
  }
  add('vehicles', 'vehicle:primary')
  add('routingconfigs', 'routing-config:depot')
  for (const zone of DEMO_ZONES) add('routeplans', `route-snapshot:${zone.key}`)
  for (const period of financePeriods(serviceDate)) {
    for (const [collection, prefix] of [
      ['sales', 'sale'], ['itemsales', 'item-sale'], ['buys', 'buy'],
      ['itembuys', 'item-buy'], ['expenses', 'expense']
    ] as const) add(collection, `finance:${prefix}:${period.key}`)
    for (let index = 1; index <= 20; index += 1) {
      add('sales', `finance:sale:${period.key}:${index}`)
      add('itemsales', `finance:item-sale:${period.key}:${index}`)
    }
    for (let index = 1; index <= 6; index += 1) {
      add('buys', `finance:buy:${period.key}:${index}`)
      add('itembuys', `finance:item-buy:${period.key}:${index}`)
    }
    for (let index = 1; index <= 10; index += 1) add('expenses', `finance:expense:${period.key}:${index}`)
  }
  add('cashflowconfigs', 'finance:cashflow-config')
  for (let product = 0; product < 85; product += 1) {
    const productKey = product === 0 ? 'catalog:product' : `catalog:product:${Math.floor((product - 1) / DEMO_VARIANTS.length) + 1}:${((product - 1) % DEMO_VARIANTS.length) + 1}`
    add('products', `stock:${productKey}`)
    for (let bucket = 1; bucket <= 2; bucket += 1) {
      const key = `stock:bucket:${productKey}:${bucket}`
      add('stockexpirybuckets', key)
      add('inventorymovements', `stock:opening:${productKey}:${bucket}`)
    }
  }
  return keys
}

const assertOwned = (value: unknown, key: string): void => {
  const record = asRecord(value)
  if (record?.fixtureNamespace !== FIXTURE_NAMESPACE || record.fixtureKey !== key) {
    throw new Error(`Demo fixture identity conflict for ${key}`)
  }
}

export const inspectDemoFixtures = async (
  database: DemoDatabase, serviceDate: Date, missingKeys?: Set<string>
): Promise<{ total: number, missing: number }> => {
  const keys = ownedFixtureKeys(serviceDate)
  let missing = 0
  let next = 0
  let failed = false
  let failure: unknown
  const worker = async (): Promise<void> => {
    while (next < keys.length && !failed) {
      const { collection, key } = keys[next++]
      try {
        const stockProductKey = collection === 'products' && key.startsWith('stock:')
        const productFixtureKey = stockProductKey ? key.slice('stock:'.length) : key
        const existing = await database.collection(collection).findOne({ _id: fixtureObjectId(productFixtureKey) })
        if (existing === null) {
          missing += 1
          missingKeys?.add(key)
        } else {
          if (stockProductKey) {
            const product = asRecord(existing)
            const inventory = asRecord(product?.inventory)
            if (inventory?.fixtureNamespace !== FIXTURE_NAMESPACE || inventory.fixtureKey !== key) {
              if (product?.inventory !== undefined && product.inventory !== null) throw new Error(`Demo stock fixture identity conflict for ${productFixtureKey}`)
              missing += 1
              missingKeys?.add(key)
            }
          } else assertOwned(existing, key)
        }
      } catch (error) {
        failed = true
        failure = error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(16, keys.length) }, worker))
  if (failed) throw failure instanceof Error ? failure : new Error('Demo fixture inventory failed')
  return { total: keys.length, missing }
}

const insertMissingFixture = async (
  collection: FixtureCollection, key: string, id: Types.ObjectId,
  payload: Record<string, unknown>, now: Date
): Promise<FixtureOutcome> => {
  const { createdAt, ...fields } = payload
  try {
    const result = await collection.updateOne(
      { _id: id },
      { $setOnInsert: { ...fields, _id: id, createdAt: createdAt ?? now, updatedAt: now, fixtureNamespace: FIXTURE_NAMESPACE, fixtureKey: key } },
      { upsert: true }
    )
    if (result.upsertedCount > 0) return FIXTURE_OUTCOME.INSERTED
  } catch (error) {
    if (asRecord(error)?.code !== 11000) throw error
  }
  const winner = await collection.findOne({ _id: id })
  assertOwned(winner, key)
  return FIXTURE_OUTCOME.UPDATED
}

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
  const requested = parseStreetAddress(address)
  const resolved = parseStreetAddress(candidate.formattedAddress)
  if (requested === undefined || resolved === undefined || requested.street !== resolved.street || requested.number !== resolved.number ||
      requested.city !== resolved.city) {
    throw new Error(`Geocoding for ${address} did not match the requested street, number, and city`)
  }
  return candidate
}

const normalizeAddressText = (value: string): string => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/\bav(?:enida)?\.?\b/g, 'avenida').replace(/\bgral\.?\b/g, 'general')
  .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')

const parseStreetAddress = (value: string): { street: string, number: string, city: string } | undefined => {
  const [line, city] = value.split(',').map(normalizeAddressText)
  if (line === undefined || city === undefined || city === '') return undefined
  const match = /^(.*\D)\s+(\d+[a-z]?)$/.exec(line) ?? /^(\d+[a-z]?)\s+(.*\D)$/.exec(line)
  if (match === null) return undefined
  const numberFirst = /^\d/.test(match[1])
  return { street: numberFirst ? match[2].trim() : match[1].trim(), number: numberFirst ? match[1] : match[2], city }
}

export const validateRoadConnectivity = async (
  depot: RouteLocation,
  clients: RouteLocation[],
  matrix: DemoProviders['matrix']
): Promise<RouteMatrix> => {
  if (clients.length > ROUTE_MAX_STOPS) throw new Error('Demo clients exceed the route stop limit')
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
  const { createdAt, ...fields } = payload
  const result = await collection.updateOne(
    { _id: id, fixtureNamespace: FIXTURE_NAMESPACE, fixtureKey: key },
    {
      $set: { ...fields, fixtureNamespace: FIXTURE_NAMESPACE, fixtureKey: key, updatedAt: now },
      $setOnInsert: { _id: id, createdAt: createdAt ?? now }
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

export const resolveServiceDate = (value: string | undefined, now: Date): Date => {
  const serviceDate = value === undefined || value.trim() === '' ? now.toISOString().slice(0, 10) : value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) throw new Error('DEMO_SERVICE_DATE must be a YYYY-MM-DD date')
  const date = new Date(`${serviceDate}T00:00:00.000Z`)
  const [year, month, day] = serviceDate.split('-').map(Number)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error('DEMO_SERVICE_DATE must be a real calendar date')
  }
  return date
}

const financeDate = (key: string, day: number, anchor: Date): Date => {
  const date = new Date(`${key}-${String(day).padStart(2, '0')}T12:00:00.000Z`)
  return date > anchor ? new Date(anchor) : date
}

const financePeriods = (anchor: Date): Array<{ key: string, date: Date, saleTotal: number, buyTotal: number, expenseCents: number }> =>
  Array.from({ length: 6 }, (_, index) => {
    const month = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - 5 + index, 1))
    const key = month.toISOString().slice(0, 7)
    const absoluteIndex = (month.getUTCFullYear() - 2026) * 12 + month.getUTCMonth() - 4
    const legacy = LEGACY_FINANCE_TOTALS[absoluteIndex]
    return {
      key,
      date: financeDate(key, key === '2026-10' ? 10 : 15, anchor),
      saleTotal: legacy?.saleTotal ?? 15800 + Math.max(0, absoluteIndex) * 1150,
      buyTotal: legacy?.buyTotal ?? 7200 + Math.max(0, absoluteIndex) * 650,
      expenseCents: legacy?.expenseCents ?? 130000 + Math.max(0, absoluteIndex) * 21000
    }
  })

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

export const assertDemoAdmin = async (database: DemoDatabase): Promise<void> => {
  await readAdminId(database)
}

const manualLocation = (spec: (typeof DEMO_ADDRESS_SPECS)[number]): GeocodedLocation => {
  const coordinates = MANUAL_DEMO_COORDINATES[spec.key]
  if (coordinates === undefined) throw new Error(`Missing manual demo coordinates for ${spec.key}`)
  return {
    id: spec.key,
    key: spec.key,
    name: spec.name,
    latitude: coordinates.lat,
    longitude: coordinates.lng,
    requestedAddress: spec.address,
    formattedAddress: spec.address,
    placeId: `manual:${spec.key}`,
    precision: GEOCODING_PRECISION.APPROXIMATE
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
  const depot = manualLocation(DEMO_ADDRESS_SPECS[0])
  const clients = DEMO_ADDRESS_SPECS.slice(1).map((spec) => manualLocation(spec))
  const places = [depot, ...clients]
  if (new Set(places.map((location) => location.placeId)).size !== places.length ||
      new Set(places.map((location) => `${location.latitude}:${location.longitude}`)).size !== places.length ||
      places.some((location) => !/san miguel de tucum[aá]n/i.test(location.formattedAddress))) {
    throw new Error('Demo geocoding did not resolve distinct locations in San Miguel de Tucumán')
  }
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
  source: GEOCODING_SOURCE.MANUAL,
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
    clientId: String(fixtureObjectId(client.key)),
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
        source: GEOCODING_SOURCE.MANUAL,
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

const SEED_WRITE_CONCURRENCY = 8

const seedPreparedData = async (
  database: DemoDatabase,
  prepared: Awaited<ReturnType<typeof prepareSeed>>,
  serviceDate: Date,
  now: Date,
  insertOnly = false,
  missingKeys?: Set<string>,
  existingAdminId?: Types.ObjectId
): Promise<DemoSummary> => {
  const summary = createSummary()
  const adminId = existingAdminId ?? await readAdminId(database)
  const pending: Array<() => Promise<void>> = []
  const write = (collectionName: string, key: string, id: Types.ObjectId, payload: Record<string, unknown>): void => {
    if (insertOnly && missingKeys !== undefined && !missingKeys.has(key)) return
    pending.push(async () => {
      const collection = database.collection(collectionName)
      recordOutcome(summary, collectionName, await (insertOnly
        ? insertMissingFixture(collection, key, id, payload, now)
        : upsertFixture(collection, key, id, payload, now)))
    })
  }

  const categoryId = fixtureObjectId('catalog:category')
  const brandId = fixtureObjectId('catalog:brand')
  const providerId = fixtureObjectId('catalog:provider')
  const productId = fixtureObjectId('catalog:product')
  write('categories', 'catalog:category', categoryId, { descripcion: 'GZ Demo Catalog' })
  write('brands', 'catalog:brand', brandId, { descripcion: 'GZ Demo Brand' })
  write('providers', 'catalog:provider', providerId, { descripcion: 'GZ Demo Supplier' })
  write('products', 'catalog:product', productId, {
    descripcion: DEMO_PRODUCT.description,
    stock: 500,
    codigoBarra: DEMO_PRODUCT.barcode,
    precioCompra: DEMO_PRODUCT.purchasePrice,
    precioUnitario: DEMO_PRODUCT.salePrice,
    categoria: categoryId,
    marca: brandId,
    proveedor: providerId
  })

  const categoryIds: Types.ObjectId[] = []
  const brandIds: Types.ObjectId[] = []
  const providerIds: Types.ObjectId[] = []
  for (const [index, name] of DEMO_CATEGORIES.entries()) {
    const id = fixtureObjectId(`catalog:category:${index + 1}`)
    categoryIds.push(id)
    write('categories', `catalog:category:${index + 1}`, id, { descripcion: `GZ Demo ${name}` })
  }
  for (const [index, name] of DEMO_BRANDS.entries()) {
    const id = fixtureObjectId(`catalog:brand:${index + 1}`)
    brandIds.push(id)
    write('brands', `catalog:brand:${index + 1}`, id, { descripcion: `GZ Demo ${name}` })
  }
  for (const [index, name] of DEMO_PROVIDERS.entries()) {
    const id = fixtureObjectId(`catalog:provider:${index + 1}`)
    providerIds.push(id)
    write('providers', `catalog:provider:${index + 1}`, id, { descripcion: `GZ Demo ${name}` })
  }
  for (const [categoryIndex, category] of DEMO_CATEGORIES.entries()) {
    for (const [variantIndex, variant] of DEMO_VARIANTS.entries()) {
      const key = `catalog:product:${categoryIndex + 1}:${variantIndex + 1}`
      const purchasePrice = 80 + categoryIndex * 25 + variantIndex * 7
      write('products', key, fixtureObjectId(key), {
        descripcion: `GZ Demo ${category} ${variant}`,
        stock: 120 + variantIndex * 10,
        codigoBarra: `GZ-DEMO-${categoryIndex + 1}-${String(variantIndex + 1).padStart(2, '0')}`,
        precioCompra: purchasePrice,
        precioUnitario: purchasePrice + 40,
        categoria: categoryIds[categoryIndex],
        marca: brandIds[(categoryIndex + variantIndex) % brandIds.length],
        proveedor: providerIds[(categoryIndex + variantIndex) % providerIds.length]
      })
    }
  }

  const zoneIds = new Map<string, Types.ObjectId>()
  for (const zone of DEMO_ZONES) {
    const id = fixtureObjectId(`zone:${zone.key}`)
    zoneIds.set(zone.key, id)
    write('deliveryzones', `zone:${zone.key}`, id, { code: zone.code, name: zone.name, normalizedName: zone.key, active: true })
  }

  const clientIds = new Map<string, Types.ObjectId>()
  for (const client of prepared.clients) {
    const id = fixtureObjectId(client.key)
    clientIds.set(client.key, id)
    const zoneKey = client.key.split(':')[1]
    const zoneId = zoneIds.get(zoneKey)
    if (zoneId === undefined) throw new Error('Demo client zone is not configured')
    write('clients', client.key, id, { ...locationDocument(client, now, adminId), deliveryZoneId: zoneId })
  }

  const vehicleId = fixtureObjectId('vehicle:primary')
  write('vehicles', 'vehicle:primary', vehicleId, {
    code: DEMO_VEHICLE.code,
    fuelConsumptionLitersPer100Km: DEMO_VEHICLE.fuelConsumptionLitersPer100Km,
    attributes: { fixture: FIXTURE_NAMESPACE, capacity: 'demo' },
    active: true
  })

  const depot = prepared.depot
  write('routingconfigs', 'routing-config:depot', fixtureObjectId('routing-config:depot'), {
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
        source: GEOCODING_SOURCE.MANUAL,
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
    write('sales', `route-sale:${client.key}`, saleId, {
      estado: 'CREATED',
      total: quantity * DEMO_PRODUCT.salePrice,
      user: adminId,
      cliente: client.name,
      idCliente: clientId,
      delivery: { status: SALE_DELIVERY_STATUS.PENDING, serviceDate }
    })
    write('itemsales', `route-item-sale:${client.key}`, fixtureObjectId(`route-item-sale:${client.key}`), {
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
    write('routeplans', `route-snapshot:${snapshot.zoneKey}`, fixtureObjectId(`route-snapshot:${snapshot.zoneKey}`), buildSnapshot(snapshot, depot, serviceDate, adminId, vehicleId, saleIds))
  }

  for (const period of financePeriods(serviceDate)) {
    const index = (Number(period.key.slice(0, 4)) - 2026) * 12 + Number(period.key.slice(5)) - 5
    const client = prepared.clients[index % prepared.clients.length]
    const clientId = clientIds.get(client.key)
    if (clientId === undefined) throw new Error('Finance fixture client identifier is missing')
    const date = period.date
    const saleId = fixtureObjectId(`finance:sale:${period.key}`)
    write('sales', `finance:sale:${period.key}`, saleId, {
      estado: 'COMPLETED',
      total: period.saleTotal,
      user: adminId,
      cliente: client.name,
      idCliente: clientId,
      paidAt: date,
      createdAt: date,
      delivery: { status: SALE_DELIVERY_STATUS.DELIVERED, deliveredAt: date }
    })
    write('itemsales', `finance:item-sale:${period.key}`, fixtureObjectId(`finance:item-sale:${period.key}`), {
      idVenta: saleId,
      idProducto: productId,
      cantidad: 10,
      total: period.saleTotal,
      estado: true,
      precioUnitario: period.saleTotal / 10
    })

    const buyId = fixtureObjectId(`finance:buy:${period.key}`)
    write('buys', `finance:buy:${period.key}`, buyId, {
      estado: 'paid',
      total: period.buyTotal,
      user: adminId,
      proveedor: 'GZ Demo Supplier',
      fecha: date,
      paidAt: date,
      createdAt: date,
      docNumber: `GZ-DEMO-${period.key}`
    })
    write('itembuys', `finance:item-buy:${period.key}`, fixtureObjectId(`finance:item-buy:${period.key}`), {
      idBuy: buyId,
      idProducto: productId,
      cantidad: 10,
      total: period.buyTotal,
      precio: period.buyTotal / 10,
      estado: true
    })

    write('expenses', `finance:expense:${period.key}`, fixtureObjectId(`finance:expense:${period.key}`), {
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

    for (let saleIndex = 1; saleIndex <= 20; saleIndex += 1) {
      const key = `finance:sale:${period.key}:${saleIndex}`
      const saleClient = prepared.clients[(index * 20 + saleIndex) % prepared.clients.length]
      const saleClientId = clientIds.get(saleClient.key)
      if (saleClientId === undefined) throw new Error('Finance fixture client identifier is missing')
      const paidAt = financeDate(period.key, saleIndex, serviceDate)
      const total = 900 + index * 135 + saleIndex * 47
      const id = fixtureObjectId(key)
      write('sales', key, id, {
        estado: 'COMPLETED',
        total,
        user: adminId,
        cliente: saleClient.name,
        idCliente: saleClientId,
        paidAt,
        createdAt: paidAt,
        delivery: { status: SALE_DELIVERY_STATUS.DELIVERED, deliveredAt: paidAt }
      })
      write('itemsales', `finance:item-sale:${period.key}:${saleIndex}`, fixtureObjectId(`finance:item-sale:${period.key}:${saleIndex}`), {
        idVenta: id,
        idProducto: fixtureObjectId(`catalog:product:${(saleIndex % DEMO_CATEGORIES.length) + 1}:${(saleIndex % DEMO_VARIANTS.length) + 1}`),
        cantidad: 1,
        total,
        estado: true,
        precioUnitario: total
      })
    }

    for (let buyIndex = 1; buyIndex <= 6; buyIndex += 1) {
      const key = `finance:buy:${period.key}:${buyIndex}`
      const date = financeDate(period.key, buyIndex + 4, serviceDate)
      const total = 2500 + index * 270 + buyIndex * 115
      const id = fixtureObjectId(key)
      write('buys', key, id, {
        estado: 'paid',
        total,
        user: adminId,
        proveedor: `GZ Demo ${DEMO_PROVIDERS[(buyIndex - 1) % DEMO_PROVIDERS.length]}`,
        fecha: date,
        paidAt: date,
        createdAt: date,
        docNumber: `GZ-DEMO-${period.key}-${buyIndex}`
      })
      write('itembuys', `finance:item-buy:${period.key}:${buyIndex}`, fixtureObjectId(`finance:item-buy:${period.key}:${buyIndex}`), {
        idBuy: id,
        idProducto: fixtureObjectId(`catalog:product:1:${buyIndex}`),
        cantidad: 10,
        total,
        precio: total / 10,
        estado: true
      })
    }

    for (let expenseIndex = 1; expenseIndex <= 10; expenseIndex += 1) {
      const key = `finance:expense:${period.key}:${expenseIndex}`
      write('expenses', key, fixtureObjectId(key), {
        date: financeDate(period.key, expenseIndex + 10, serviceDate),
        amountCents: 15000 + index * 2000 + expenseIndex * 700,
        currency: 'ARS',
        category: ['Fuel', 'Utilities', 'Operations', 'Rent'][expenseIndex % 4],
        type: EXPENSE_TYPE.OPERATIVO,
        paymentMethod: PAYMENT_METHOD.TRANSFERENCIA,
        description: `GZ demo operating expense ${period.key} ${expenseIndex}`,
        relatedTo: { kind: RELATED_KIND.NONE },
        createdBy: adminId,
        isDeleted: false
      })
    }
  }

  write('cashflowconfigs', 'finance:cashflow-config', fixtureObjectId('finance:cashflow-config'), {
    openingBalance: 100000,
    reserveMonthsMultiplier: 1,
    deficitAlertEnabled: true,
    idleCapitalRecommendMin: 25000
  })

  const flush = async (): Promise<void> => {
    let next = 0
    let failed = false
    let failure: unknown
    const worker = async (): Promise<void> => {
      while (next < pending.length && !failed) {
        const task = pending[next++]
        try { await task() } catch (error) { failed = true; failure = error }
      }
    }
    await Promise.all(Array.from({ length: Math.min(SEED_WRITE_CONCURRENCY, pending.length) }, worker))
    if (failed) throw failure instanceof Error ? failure : new Error('Demo fixture write failed')
    pending.length = 0
  }

  await flush()
  for (let productIndex = 0; productIndex < 85; productIndex += 1) {
    const productKey = productIndex === 0 ? 'catalog:product' : `catalog:product:${Math.floor((productIndex - 1) / DEMO_VARIANTS.length) + 1}:${((productIndex - 1) % DEMO_VARIANTS.length) + 1}`
    const stockKey = `stock:${productKey}`
    const productId = fixtureObjectId(productKey)
    const physicalQuantity = productIndex === 0 ? 500 : 120 + ((productIndex - 1) % DEMO_VARIANTS.length) * 10
    const firstQuantity = Math.floor(physicalQuantity * (productIndex % 2 === 0 ? 0.7 : 0.35))
    const quantities = [firstQuantity, physicalQuantity - firstQuantity]
    const minimum = productIndex % 5 === 0 ? physicalQuantity + 5 : Math.max(10, physicalQuantity - 10)
    const productCollection = database.collection('products')
    if (!insertOnly || missingKeys === undefined || missingKeys.has(stockKey)) {
      const productResult = await productCollection.updateOne(
        { _id: productId, fixtureNamespace: FIXTURE_NAMESPACE, fixtureKey: productKey, inventory: { $exists: false } },
        { $set: { inventory: { minimum, expiryTracking: 'tracked', baselineStatus: 'reconciled', lastReconciledAt: serviceDate, lastReconciledBy: adminId, fixtureNamespace: FIXTURE_NAMESPACE, fixtureKey: stockKey } }, $setOnInsert: {} },
        { upsert: false }
      )
      if (productResult.upsertedCount > 0 || productResult.modifiedCount === 0) {
        const existing = await productCollection.findOne({ _id: productId })
        const existingProduct = asRecord(existing)
        const inventory = asRecord(existingProduct?.inventory)
        if (inventory?.fixtureNamespace !== FIXTURE_NAMESPACE || inventory.fixtureKey !== stockKey) {
          throw new Error(`Demo stock fixture identity conflict for ${productKey}`)
        }
      } else recordOutcome(summary, 'products', FIXTURE_OUTCOME.UPDATED)
    }
    for (let bucketIndex = 0; bucketIndex < 2; bucketIndex += 1) {
      const bucketKey = `stock:bucket:${productKey}:${bucketIndex + 1}`
      const movementKey = `stock:opening:${productKey}:${bucketIndex + 1}`
      const bucketId = fixtureObjectId(bucketKey)
      const expiryDate = new Date(`${bucketIndex === 0 ? '2026-10-15' : '2026-11-30'}T00:00:00.000Z`)
      const quantity = quantities[bucketIndex]
      const bucketPayload = { _id: bucketId, productId, expiryDate, receivedQuantity: quantity, availableQuantity: quantity, committedQuantity: 0, fixtureNamespace: FIXTURE_NAMESPACE, fixtureKey: bucketKey, createdAt: now, updatedAt: now }
      if (quantity > 0) {
        if (!insertOnly || missingKeys === undefined || missingKeys.has(bucketKey)) {
          const outcome = insertOnly ? await insertMissingFixture(database.collection('stockexpirybuckets'), bucketKey, bucketId, bucketPayload, now) : await upsertFixture(database.collection('stockexpirybuckets'), bucketKey, bucketId, bucketPayload, now)
          recordOutcome(summary, 'stockexpirybuckets', outcome)
        }
        const movementId = fixtureObjectId(movementKey)
        const movementPayload = { _id: movementId, productId, expiryBucketId: bucketId, type: 'OPENING', quantity, occurredAt: serviceDate, sourceType: 'opening-count', sourceId: 'gzapi-demo-stock-v1', sourceEvent: 'opening-count', operationId: 'gzapi-demo-stock-opening-v1', idempotencyKey: movementKey, rulesVersion: 'stock-rules-v1', reason: 'Fictional demo opening balance', createdBy: adminId, fixtureNamespace: FIXTURE_NAMESPACE, fixtureKey: movementKey, createdAt: now, updatedAt: now }
        if (!insertOnly || missingKeys === undefined || missingKeys.has(movementKey)) {
          const movement = insertOnly ? await insertMissingFixture(database.collection('inventorymovements'), movementKey, movementId, movementPayload, now) : await upsertFixture(database.collection('inventorymovements'), movementKey, movementId, movementPayload, now)
          recordOutcome(summary, 'inventorymovements', movement)
        }
      }
    }
  }
  return summary
}

export const runDemoSeed = async (input: {
  target: DemoTarget
  dryRun: boolean
  database?: DemoDatabase
  providers?: DemoProviders
  serviceDate?: Date
  now?: Date
  insertOnly?: boolean
}): Promise<DemoSeedResult> => {
  if (input.dryRun) {
    return { dryRun: true, target: { database: input.target.database, remote: input.target.remote }, addressCount: DEMO_ADDRESS_SPECS.length }
  }
  if (input.database === undefined || input.providers === undefined) throw new Error('Demo seed dependencies are not configured')
  const serviceDate = input.serviceDate ?? resolveServiceDate(undefined, input.now ?? new Date())
  if (Number.isNaN(serviceDate.getTime())) throw new Error('DEMO_SERVICE_DATE must be a real calendar date')
  if (input.insertOnly === true) {
    const missingKeys = new Set<string>()
    const inventory = await inspectDemoFixtures(input.database, serviceDate, missingKeys)
    if (inventory.missing === 0) {
      return { dryRun: false, target: { database: input.target.database, remote: input.target.remote }, addressCount: DEMO_ADDRESS_SPECS.length, summary: createSummary() }
    }
    const adminId = await readAdminId(input.database)
    const prepared = await prepareSeed(input.providers)
    const summary = await seedPreparedData(input.database, prepared, serviceDate, input.now ?? new Date(), true, missingKeys, adminId)
    return { dryRun: false, target: { database: input.target.database, remote: input.target.remote }, addressCount: DEMO_ADDRESS_SPECS.length, summary }
  }
  const prepared = await prepareSeed(input.providers)
  const summary = await seedPreparedData(input.database, prepared, serviceDate, input.now ?? new Date(), input.insertOnly)
  return { dryRun: false, target: { database: input.target.database, remote: input.target.remote }, addressCount: DEMO_ADDRESS_SPECS.length, summary }
}

export const mongoDatabase = (): DemoDatabase => {
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
    process.stdout.write(`Demo seed dry run: ${result.addressCount} candidate addresses planned for ${result.target.remote ? 'remote' : 'local'} database ${result.target.database}\n`)
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
      serviceDate: resolveServiceDate(process.env.DEMO_SERVICE_DATE, new Date())
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
