import RoleModel from '../models/role'
import UserModel from '../models/user'
import { encrypt } from '../utils/bcrypt.handle'
import { createHash } from 'crypto'
import mongoose, { Types } from 'mongoose'
import type { Document, UpdateFilter } from 'mongodb'
import { STOCK_RULES_VERSION, STOCK_TIME_ZONE } from '../config/stock'
import {
  GEOCODING_PRECISION,
  GEOCODING_SOURCE,
  GEOCODING_STATUS
} from '../interfaces/client.interface'
import {
  DEFAULT_ROUTE_ALGORITHM,
  ROUTING_CONFIG_KEYS,
  ROUTE_MODES,
  type RouteLocation,
  type RouteMatrix,
  type RouteMatrixRequest
} from '../interfaces/routeOptimization.interface'
import type { GeocodingCandidate } from '../schemas/clientGeocoding'

import type { computeRoute } from './routeMatrixProvider'
import { seedSimulationDemoFixtures } from './simulation'

const BASE_PERMISSIONS = [
  'create_user', 'delete_user', 'update_user', 'read_user',
  'create_role', 'delete_role', 'update_role', 'read_role',
  'create_product', 'delete_product', 'update_product', 'read_product',
  'create_client', 'delete_client', 'update_client', 'read_client',
  'create_sale', 'delete_sale', 'update_sale', 'read_sale', 'read_stats',
  'create_buy', 'delete_buy', 'update_buy', 'read_buy',
  'create_expense', 'delete_expense', 'update_expense', 'read_expense',
  'read_dataset',
  'read_log',
  'catalog_read', 'catalog_write',
  'read_cashflow', 'configure_cashflow',
  'confirm_client_location',
  'read_route_plan', 'create_route_plan', 'manage_route_config', 'manage_delivery_zone'
]

export const SIMULATION_ROLE_GRANTS = {
  Propietario: ['simulation:read', 'simulation:write'],
  Administración: ['simulation:read', 'simulation:write'],
  Preventista: [],
  Repartidor: ['simulation:read']
} as const

const PHASE_0_ROLE_GRANTS = [
  {
    name: 'Propietario',
    permissions: [
      'confirm_sale_payment', 'refund_sale', 'confirm_purchase_payment',
      'receive_purchase', 'adjust_stock', 'read_route_plan', 'create_route_plan',
      'confirm_client_location', 'manage_route_config', 'manage_delivery_zone',
      ...SIMULATION_ROLE_GRANTS.Propietario
    ]
  },
  {
    name: 'Administración',
    permissions: [
      'confirm_sale_payment', 'refund_sale', 'confirm_purchase_payment',
      'receive_purchase', 'adjust_stock', 'read_route_plan', 'create_route_plan',
      'confirm_client_location', 'manage_route_config', 'manage_delivery_zone',
      ...SIMULATION_ROLE_GRANTS.Administración
    ]
  },
  {
    name: 'Preventista',
    permissions: ['confirm_sale_payment', ...SIMULATION_ROLE_GRANTS.Preventista]
  },
  {
    name: 'Repartidor',
    permissions: ['read_route_plan', ...SIMULATION_ROLE_GRANTS.Repartidor]
  }
]

const upsertRole = async (name: string, permissions: string[]): Promise<void> => {
  const existing = await RoleModel.findOne({ name })

  if (existing === null) {
    await RoleModel.create({ name, permissions })
    return
  }

  const missing = permissions.filter((permission) => !existing.permissions.includes(permission))
  if (missing.length > 0) {
    existing.permissions = [...new Set([...existing.permissions, ...missing])]
    await existing.save()
  }
}

type SeedDatabaseDependencies = Partial<{
  seedBase: () => Promise<void>
  seedDemoFixtures: () => Promise<void>
}>

const seedBaseDatabase = async (): Promise<void> => {
  console.log('Iniciando seed de la base de datos')

  await upsertRole('admin', BASE_PERMISSIONS)

  for (const grant of PHASE_0_ROLE_GRANTS) {
    await upsertRole(grant.name, grant.permissions)
  }

  await seedSimulationDemoFixtures()

  const adminUser = await UserModel.findOne({ nickname: 'admin' })

  if (adminUser === null) {
    const configuredAdminPassword = process.env.ADMIN_PASSWORD
    const adminPassword = configuredAdminPassword === undefined || configuredAdminPassword === ''
      ? '123'
      : configuredAdminPassword
    const passHash = await encrypt(adminPassword)
    const adminRole = await RoleModel.findOne({ name: 'admin' })
    if (adminRole === null) {
      throw new Error('No se pudo encontrar el rol de administrador')
    }

    try {
      await UserModel.create({
        nickname: 'admin',
        password: passHash,
        role: adminRole._id
      })
    } catch (error) {
      // Another instance created the admin between our read and write: that is the desired end state.
      if ((error as { code?: number }).code !== 11000) throw error
    }
  } else {
    const adminRole = await RoleModel.findOne({ name: 'admin' })
    if (adminRole !== null && String(adminUser.role) !== String(adminRole._id)) {
      adminUser.role = adminRole
      await adminUser.save()
    }
  }
}

export const seedDatabase = async (dependencies: SeedDatabaseDependencies = {}): Promise<void> => {
  await (dependencies.seedBase ?? seedBaseDatabase)()
  await (dependencies.seedDemoFixtures ?? seedDemoFixtures)()
}

const DEFAULT_MONGO_URI = 'mongodb://127.0.0.1:27017/gzapi'
const FIXTURE_NAMESPACE = 'gzapi-demo-seed-v1'
const ROUTE_FUEL_CONSUMPTION = 8.5
const ROUTE_MAX_STOPS = 20

const FIXTURE_OUTCOME = {
  INSERTED: 'inserted',
  UPDATED: 'updated'
} as const

type FixtureOutcome = (typeof FIXTURE_OUTCOME)[keyof typeof FIXTURE_OUTCOME]

// The retained depot fixture uses the existing, fixed demo coordinates.
const DEMO_ADDRESS_SPECS = [{
  key: 'depot',
  name: 'Depósito',
  address: 'Av. Mate de Luna 4357, San Miguel de Tucumán, Tucumán, Argentina'
}]

const MANUAL_DEMO_COORDINATES: Record<string, { lat: number, lng: number }> = {
  depot: { lat: -26.8193761, lng: -65.2589428 }
}

type DemoAddressKey = (typeof DEMO_ADDRESS_SPECS)[number]['key']

const DEMO_ZONES = [
  { key: 'centro', code: 'MOLLAR', name: 'Mollar' },
  { key: 'oeste', code: 'TAFI_DEL_VALLE', name: 'Tafí del Valle' },
  { key: 'sur', code: 'SANTA_LUCIA', name: 'Santa Lucía' },
  { key: 'soldado-maldonado', code: 'SOLDADO_MALDONADO', name: 'Soldado Maldonado' }
] as const

const DEMO_VEHICLE = {
  code: '01',
  fuelConsumptionLitersPer100Km: ROUTE_FUEL_CONSUMPTION
} as const

const DEMO_CATEGORIES = ['Bebidas', 'Almacén', 'Limpieza', 'Cuidado personal', 'Aperitivos', 'Despensa'] as const
const DEMO_BRANDS = ['Andes', 'Norte', 'Pampa', 'Sol', 'Río', 'Valle', 'Campo', 'Luna'] as const
const DEMO_PROVIDERS = ['Distribuidora Norte', 'Abastecimiento Regional', 'Mayorista del Valle', 'Comercializadora del Río', 'Mercadería Central'] as const

// Illustrative prices only; zero stock is not an inventory reconciliation.
const PRODUCT_FIXTURES = [
  ['Agua mineral sin gas 1,5 l', 1, 1, 1, 950],
  ['Agua mineral con gas 500 ml', 1, 2, 1, 700],
  ['Jugo de naranja 1 l', 1, 4, 2, 1800],
  ['Gaseosa de pomelo 2,25 l', 1, 5, 2, 2400],
  ['Arroz largo fino 1 kg', 2, 3, 3, 2200],
  ['Fideos secos tirabuzón 500 g', 2, 6, 3, 1300],
  ['Harina de trigo 1 kg', 2, 7, 3, 1100],
  ['Azúcar blanca 1 kg', 6, 4, 5, 1500],
  ['Aceite de girasol 900 ml', 6, 7, 5, 3200],
  ['Yerba mate 1 kg', 6, 2, 5, 4800],
  ['Detergente líquido 750 ml', 3, 5, 4, 1900],
  ['Lavandina 1 l', 3, 1, 4, 1200],
  ['Jabón de tocador 125 g', 4, 8, 4, 1000],
  ['Papas fritas clásicas 150 g', 5, 6, 2, 2100],
  ['Galletitas de agua 200 g', 5, 3, 5, 1400]
] as const

// Fictional business identities, deliberately without addresses or contact details.
const CLIENT_FIXTURES = [
  ['Almacén Brisa de Piedra', 'centro'], ['Despensa Sendero Claro', 'centro'], ['Kiosco Nube Serrana', 'centro'],
  ['Almacén Rincón del Alba', 'oeste'], ['Despensa Camino de Niebla', 'oeste'], ['Kiosco Estrella del Cerro', 'oeste'],
  ['Almacén Hoja Dorada', 'sur'], ['Despensa Puente de Luz', 'sur'], ['Kiosco Ronda del Sol', 'sur'],
  ['Almacén Trébol de Cobre', 'soldado-maldonado'], ['Despensa Patio del Viento', 'soldado-maldonado'], ['Kiosco Río de Papel', 'soldado-maldonado']
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
    options: { upsert: boolean }
  ) => Promise<WriteResult>
}

interface FixtureUpdate {
  $set?: Record<string, unknown>
  $setOnInsert: Record<string, unknown>
}

export interface DemoDatabase {
  collection: (name: string) => FixtureCollection
  withTransaction?: <T>(work: (database: DemoDatabase) => Promise<T>) => Promise<T>
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

const stockExpiry = (now: Date, index: number): Date => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: STOCK_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value)
  const year = value('year')
  const month = value('month') - 1
  const day = value('day')
  if (index < 6) return new Date(Date.UTC(year, month, day + (index < 3 ? -1 : 20)))
  const lastDay = new Date(Date.UTC(year, month + 7, 0)).getUTCDate()
  return new Date(Date.UTC(year, month + 6, Math.min(day, lastDay)))
}

const assertSeedStockEvidence = async (database: DemoDatabase, key: string): Promise<void> => {
  const productId = fixtureObjectId(key)
  const bucket = asRecord(await database.collection('stockexpirybuckets').findOne({ _id: fixtureObjectId(`${key}:bucket`) }))
  const movement = asRecord(await database.collection('inventorymovements').findOne({ _id: fixtureObjectId(`${key}:movement`) }))
  if (String(bucket?.productId) !== String(productId) || String(movement?.productId) !== String(productId) ||
      String(movement?.expiryBucketId) !== String(bucket?._id) || movement?.sourceType !== 'SYSTEM_SEED' ||
      movement.sourceEvent !== 'FIXTURE_STOCK_INITIALIZED') throw new Error(`Missing or conflicting inventory evidence for ${key}`)
}

const seedProduct = async (database: DemoDatabase, index: number, payload: Record<string, unknown>, now: Date, adminId: Types.ObjectId): Promise<FixtureOutcome> => {
  if (database.withTransaction === undefined) throw new Error('Demo product stock requires MongoDB transactions')
  const key = `fixture-product:${index + 1}`
  const productId = fixtureObjectId(key)
  const bucketId = fixtureObjectId(`${key}:bucket`)
  const movementId = fixtureObjectId(`${key}:movement`)
  const quantity = 50 + index * 7
  return await database.withTransaction(async (transaction) => {
    const products = transaction.collection('products')
    const existing = await products.findOne({ _id: productId })
    if (existing !== null) {
      assertOwned(existing, key)
      if (asRecord(existing)?.fixtureStockVersion === 1) await assertSeedStockEvidence(transaction, key)
      return FIXTURE_OUTCOME.UPDATED
    }
    for (const name of ['stockexpirybuckets', 'inventorymovements']) {
      if (await transaction.collection(name).findOne({ productId }) !== null) throw new Error(`Existing inventory evidence for missing ${key}`)
    }
    const insert = async (name: string, id: Types.ObjectId, fields: Record<string, unknown>): Promise<void> => {
      const result = await transaction.collection(name).updateOne({ _id: id }, { $setOnInsert: { ...fields, _id: id, createdAt: now, updatedAt: now } }, { upsert: true })
      if (result.upsertedCount !== 1) throw new Error(`Demo inventory identity conflict for ${key}`)
    }
    await insert('products', productId, { ...payload, stock: quantity, inventory: { minimum: 0, expiryTracking: 'TRACKED', baselineStatus: 'RECONCILED' }, fixtureNamespace: FIXTURE_NAMESPACE, fixtureKey: key, fixtureStockVersion: 1 })
    await insert('stockexpirybuckets', bucketId, { productId, expiryDate: stockExpiry(now, index), receivedQuantity: quantity, availableQuantity: quantity, committedQuantity: 0 })
    await insert('inventorymovements', movementId, { productId, expiryBucketId: bucketId, type: 'OPENING', quantity, occurredAt: now, sourceType: 'SYSTEM_SEED', sourceId: FIXTURE_NAMESPACE, sourceEvent: 'FIXTURE_STOCK_INITIALIZED', operationId: key, idempotencyKey: `${FIXTURE_NAMESPACE}:${key}`, rulesVersion: STOCK_RULES_VERSION, createdBy: adminId })
    return FIXTURE_OUTCOME.INSERTED
  })
}

const ownedFixtureKeys = (): Array<{ collection: string, key: string }> => {
  const keys: Array<{ collection: string, key: string }> = []
  const add = (collection: string, key: string): void => { keys.push({ collection, key }) }
  for (const collection of ['categories', 'brands', 'providers']) {
    add(collection, `catalog:${collection === 'categories' ? 'category' : collection === 'brands' ? 'brand' : 'provider'}`)
  }
  for (const [collection, prefix, count] of [
    ['categories', 'category', DEMO_CATEGORIES.length],
    ['brands', 'brand', DEMO_BRANDS.length],
    ['providers', 'provider', DEMO_PROVIDERS.length]
  ] as const) {
    for (let index = 1; index <= count; index += 1) add(collection, `catalog:${prefix}:${index}`)
  }
  for (const zone of DEMO_ZONES) add('deliveryzones', `zone:${zone.key}`)
  for (const [index] of PRODUCT_FIXTURES.entries()) add('products', `fixture-product:${index + 1}`)
  for (const [index] of CLIENT_FIXTURES.entries()) add('clients', `fixture-client:${index + 1}`)
  add('vehicles', 'vehicle:primary')
  add('routingconfigs', 'routing-config:depot')
  add('cashflowconfigs', 'finance:cashflow-config')
  return keys
}

const assertOwned = (value: unknown, key: string): void => {
  const record = asRecord(value)
  if (record?.fixtureNamespace !== FIXTURE_NAMESPACE || record.fixtureKey !== key) {
    throw new Error(`Demo fixture identity conflict for ${key}`)
  }
}

export const inspectDemoFixtures = async (
  database: DemoDatabase, _serviceDate: Date, missingKeys?: Set<string>
): Promise<{ total: number, missing: number }> => {
  const keys = ownedFixtureKeys()
  let missing = 0
  let next = 0
  let failed = false
  let failure: unknown
  const worker = async (): Promise<void> => {
    while (next < keys.length && !failed) {
      const { collection, key } = keys[next++]
      try {
        const existing = await database.collection(collection).findOne({ _id: fixtureObjectId(key) })
        if (existing === null) {
          missing += 1
          missingKeys?.add(key)
        } else {
          assertOwned(existing, key)
          if (collection === 'products' && asRecord(existing)?.fixtureStockVersion === 1) {
            await assertSeedStockEvidence(database, key)
          }
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

const SEED_WRITE_CONCURRENCY = 8

const seedPreparedData = async (
  database: DemoDatabase,
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
  write('categories', 'catalog:category', categoryId, { descripcion: 'Catálogo' })
  write('brands', 'catalog:brand', brandId, { descripcion: 'Marca' })
  write('providers', 'catalog:provider', providerId, { descripcion: 'Proveedor' })
  for (const [index, name] of DEMO_CATEGORIES.entries()) {
    const id = fixtureObjectId(`catalog:category:${index + 1}`)
    write('categories', `catalog:category:${index + 1}`, id, { descripcion: name })
  }
  for (const [index, name] of DEMO_BRANDS.entries()) {
    const id = fixtureObjectId(`catalog:brand:${index + 1}`)
    write('brands', `catalog:brand:${index + 1}`, id, { descripcion: name })
  }
  for (const [index, name] of DEMO_PROVIDERS.entries()) {
    const id = fixtureObjectId(`catalog:provider:${index + 1}`)
    write('providers', `catalog:provider:${index + 1}`, id, { descripcion: name })
  }
  for (const zone of DEMO_ZONES) {
    const id = fixtureObjectId(`zone:${zone.key}`)
    write('deliveryzones', `zone:${zone.key}`, id, { code: zone.code, name: zone.name, normalizedName: zone.name.trim().toLowerCase(), active: true })
  }

  for (const [index, [description, category, brand, provider, price]] of PRODUCT_FIXTURES.entries()) {
    const key = `fixture-product:${index + 1}`
    if (insertOnly && missingKeys !== undefined && !missingKeys.has(key)) continue
    pending.push(async () => {
      recordOutcome(summary, 'products', await seedProduct(database, index, {
        descripcion: description,
        precioUnitario: price,
        categoria: fixtureObjectId(`catalog:category:${category}`),
        marca: fixtureObjectId(`catalog:brand:${brand}`),
        proveedor: fixtureObjectId(`catalog:provider:${provider}`)
      }, now, adminId))
    })
  }
  for (const [index, [name, zone]] of CLIENT_FIXTURES.entries()) {
    const key = `fixture-client:${index + 1}`
    write('clients', key, fixtureObjectId(key), {
      nombreCompleto: name,
      deliveryZoneId: fixtureObjectId(`zone:${zone}`),
      isActive: true
    })
  }

  const vehicleId = fixtureObjectId('vehicle:primary')
  write('vehicles', 'vehicle:primary', vehicleId, {
    code: DEMO_VEHICLE.code,
    fuelConsumptionLitersPer100Km: DEMO_VEHICLE.fuelConsumptionLitersPer100Km,
    attributes: { fixture: FIXTURE_NAMESPACE },
    active: true
  })

  const depot = manualLocation(DEMO_ADDRESS_SPECS[0])
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
  if (input.database === undefined) throw new Error('Demo seed dependencies are not configured')
  const serviceDate = input.serviceDate ?? resolveServiceDate(undefined, input.now ?? new Date())
  if (Number.isNaN(serviceDate.getTime())) throw new Error('DEMO_SERVICE_DATE must be a real calendar date')
  if (input.insertOnly === true) {
    const missingKeys = new Set<string>()
    const inventory = await inspectDemoFixtures(input.database, serviceDate, missingKeys)
    if (inventory.missing === 0) {
      return { dryRun: false, target: { database: input.target.database, remote: input.target.remote }, addressCount: DEMO_ADDRESS_SPECS.length, summary: createSummary() }
    }
    const adminId = await readAdminId(input.database)
    const summary = await seedPreparedData(input.database, input.now ?? new Date(), true, missingKeys, adminId)
    return { dryRun: false, target: { database: input.target.database, remote: input.target.remote }, addressCount: DEMO_ADDRESS_SPECS.length, summary }
  }
  const summary = await seedPreparedData(input.database, input.now ?? new Date(), input.insertOnly)
  return { dryRun: false, target: { database: input.target.database, remote: input.target.remote }, addressCount: DEMO_ADDRESS_SPECS.length, summary }
}

export const seedDemoFixtures = async (): Promise<DemoSeedResult> => {
  const configuredUri = process.env.MONGODB_URI?.trim()
  const uri = configuredUri === undefined || configuredUri === '' ? DEFAULT_MONGO_URI : configuredUri
  const target = resolveTarget(uri, true)
  return await runDemoSeed({
    target,
    dryRun: false,
    database: mongoDatabase(),
    serviceDate: resolveServiceDate('2026-10-21', new Date()),
    insertOnly: true
  })
}

export const mongoDatabase = (): DemoDatabase => {
  const database = mongoose.connection.db
  if (database === undefined) throw new Error('MongoDB connection did not expose a database')
  const adapter = (session?: mongoose.mongo.ClientSession): DemoDatabase => ({
    collection: (name: string): FixtureCollection => {
      const collection = database.collection(name)
      return {
        findOne: async (filter) => await collection.findOne(filter as Document, { session }),
        updateOne: async (filter, update, options) => {
          const result = await collection.updateOne(filter as Document, update as unknown as UpdateFilter<Document>, { ...options, session })
          return { upsertedCount: result.upsertedCount, modifiedCount: result.modifiedCount }
        }
      }
    },
    withTransaction: async (work) => {
      const transaction = await mongoose.connection.startSession()
      try {
        let result: Awaited<ReturnType<typeof work>> | undefined
        await transaction.withTransaction(async () => { result = await work(adapter(transaction)) })
        if (result === undefined) throw new Error('Demo inventory transaction did not complete')
        return result
      } finally { await transaction.endSession() }
    }
  })
  return adapter()
}

export { DEMO_ADDRESS_SPECS, FIXTURE_NAMESPACE }
