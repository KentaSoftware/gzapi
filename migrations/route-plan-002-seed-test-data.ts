import { createHash } from 'crypto'

import { fromZonedTime } from 'date-fns-tz'
import mongoose, { Types } from 'mongoose'

import {
  GEOCODING_PRECISION,
  GEOCODING_SOURCE,
  GEOCODING_STATUS,
  type GeocodingPrecision,
  type GeocodingSource,
  type GeocodingStatus
} from '../src/interfaces/client.interface'
import {
  DEFAULT_ROUTE_ALGORITHM,
  ROUTE_METRIC_AVAILABILITY,
  ROUTING_CONFIG_KEYS,
  ROUTE_MODES,
  type RoutePlan,
  type RoutePlanSegment,
  type RoutePlanStop,
  type RouteSnapshotSaleReference,
  type RouteStopEstimate,
  type RouteScheduleAssumptions,
  type RouteFuelAssumptions,
  type RoutingDepot
} from '../src/interfaces/routeOptimization.interface'
import { SALE_DELIVERY_STATUS } from '../src/interfaces/sale.interface'
import ClientModel from '../src/models/client'
import DeliveryZoneModel from '../src/models/deliveryZone'
import RoleModel from '../src/models/role'
import RoutePlanModel from '../src/models/routePlan'
import RoutingConfigModel from '../src/models/routingConfig'
import SaleModel from '../src/models/sale'
import UserModel from '../src/models/user'
import VehicleModel from '../src/models/vehicle'
import { encrypt } from '../src/utils/bcrypt.handle'

// Standalone, idempotent seed for Route Optimization test data.
// It only upserts the deterministic fixture documents below and never drops,
// deletes, or touches unrelated documents. Coordinates and identities are
// synthetic test fixtures, not real customer data.

const DEFAULT_MONGO_URI = 'mongodb://127.0.0.1:27017/test_route_plan'
const TARGET_DATABASE = 'test_route_plan'
const ALLOWED_HOSTS = ['127.0.0.1', 'localhost']
const DEFAULT_SERVICE_DATE = '2026-10-14'
const SERVICE_TIME_ZONE = 'America/Argentina/Buenos_Aires'
const DEFAULT_TEST_PASSWORD = 'route-plan-test-password'
const FIXTURE_NAMESPACE = 'gzapi-route-plan-test-seed-v1'

const ROUTE_TEST_ROLE_NAME = 'Route test operator'
const ROUTE_TEST_USER_NICKNAME = 'route-plan-test'
const ROUTE_TEST_PERMISSIONS = [
  'read_route_plan',
  'create_route_plan',
  'confirm_client_location',
  'manage_route_config',
  'manage_delivery_zone'
]

const FIXTURE_VALIDATED_AT = new Date('2026-01-01T00:00:00.000Z')
const DEPOT_FIXTURE = { name: 'Deposito de prueba San Miguel de Tucuman', latitude: -27.34774586607769, longitude: -65.58714233837968 }
const FUEL_COEFFICIENT = 8.5
const MAX_STOPS = 20
const TEST_PHONE_BASE = 3815000000
const SALE_TOTAL_BASE = 1000
const SALE_TOTAL_STEP = 25
const SALE_ESTADO_CREATED = 'CREATED'
const CANDIDATE_RULE_VERSION = 'candidate-eligibility-v1'
const ROUTE_TEST_VEHICLE_CODE = 'TEST-ROUTE-01'
const ROUTE_TEST_VEHICLE_FUEL = 8.5
const ROUTE_TEST_VEHICLES = [
  { key: 'TEST-ROUTE-01', code: ROUTE_TEST_VEHICLE_CODE, fuel: ROUTE_TEST_VEHICLE_FUEL },
  { key: 'TEST-ROUTE-02', code: 'TEST-ROUTE-02', fuel: 9.2 },
  { key: 'TEST-ROUTE-03', code: 'TEST-ROUTE-03', fuel: 7.8 }
] as const
const ROUTE_ESTIMATE_SPEED_KMH = 28
const ROUTE_DISTANCE_FACTOR = 1.25
const ROUTE_STOP_SERVICE_SECONDS = 180

type FixtureOutcome = 'inserted' | 'updated'

interface ZoneFixture {
  key: string
  code: string
  name: string
  // Offset-based zones anchor their clients on these base coordinates; zones
  // with explicit client coordinates provide `clients` and leave the base unset.
  latitude?: number
  longitude?: number
  clients?: ClientCoordinate[]
}

interface ClientCoordinate {
  latitude: number
  longitude: number
}

interface CoordinateOffset {
  latitudeDelta: number
  longitudeDelta: number
}

interface GroupCount {
  inserted: number
  updated: number
}

interface SeedSummary {
  routeTestRole: GroupCount
  routeTestUser: GroupCount
  deliveryZones: GroupCount
  clients: GroupCount
  sales: GroupCount
  routingConfigs: GroupCount
  vehicles: GroupCount
  routeSnapshots: GroupCount
}

interface SeedResult {
  database: string
  serviceDate: string
  serviceDateInstant: Date
  summary: SeedSummary
}

interface ClientFixture {
  id: Types.ObjectId
  nombreCompleto: string
  address: string
  telefono: number
  latitude: number
  longitude: number
  deliveryZoneId: Types.ObjectId
  isActive: boolean
  geocodingStatus: GeocodingStatus
  geocodingSource: GeocodingSource
  validatedBy?: Types.ObjectId
}

interface SaleFixture {
  id: Types.ObjectId
  userId: Types.ObjectId
  clientId: Types.ObjectId
  clientName: string
  total: number
  serviceDateInstant: Date
}

interface RoutePoint {
  latitude: number
  longitude: number
}

// Explicit, high-precision client coordinates for the Test-Route zone. These
// synthetic points are stored verbatim and must not be rounded.
const TEST_ROUTE_CLIENTS: ClientCoordinate[] = [
  { latitude: -26.85962461036464, longitude: -65.69629361944428 },
  { latitude: -26.852520208810517, longitude: -65.70331010811422 },
  { latitude: -26.858599435514773, longitude: -65.7199473568868 },
  { latitude: -26.84488292304535, longitude: -65.68517031163914 },
  { latitude: -26.592959354092393, longitude: -65.91934214376454 },
  { latitude: -26.592860593646435, longitude: -65.91936422823521 },
  { latitude: -26.94691214700121, longitude: -65.71598159529378 },
  { latitude: -26.946688314831096, longitude: -65.69913798992495 }
]

// Tucuman localities resolved at the town/locality level, not the department.
// Test-Route uses explicit client coordinates instead of deterministic offsets.
const ZONE_FIXTURES: ZoneFixture[] = [
  { key: 'tafi-del-valle', code: 'TAFI_DEL_VALLE', name: 'Tafí del Valle', latitude: -26.8666667, longitude: -65.6833333 },
  { key: 'el-mollar', code: 'EL_MOLLAR', name: 'El Mollar', latitude: -26.9209985, longitude: -65.6939078 },
  { key: 'monteros', code: 'MONTEROS', name: 'Monteros', latitude: -27.1666667, longitude: -65.5 },
  { key: 'los-sarmientos', code: 'LOS_SARMIENTOS', name: 'Los Sarmientos', latitude: -27.4138889, longitude: -65.69 },
  { key: 'aguilares', code: 'AGUILARES', name: 'Aguilares', latitude: -27.43096, longitude: -65.61302 },
  { key: 'test-route', code: 'TEST_ROUTE', name: 'Test-Route', clients: TEST_ROUTE_CLIENTS }
]

// Deterministic sub-kilometer offsets keep each client inside its locality footprint.
const CLIENT_OFFSETS: CoordinateOffset[] = [
  { latitudeDelta: 0.0021, longitudeDelta: 0.0013 },
  { latitudeDelta: -0.0018, longitudeDelta: 0.0026 },
  { latitudeDelta: 0.0032, longitudeDelta: -0.0019 },
  { latitudeDelta: -0.0027, longitudeDelta: -0.0024 },
  { latitudeDelta: 0.0009, longitudeDelta: 0.0034 }
]

// Resolve each client position for a zone: explicit coordinates are used
// verbatim, while offset zones keep the existing 6-decimal deterministic math.
const buildZoneClientCoordinates = (zone: ZoneFixture): ClientCoordinate[] => {
  if (zone.clients !== undefined) return zone.clients
  if (zone.latitude === undefined || zone.longitude === undefined) {
    throw new Error(`Delivery zone ${zone.key} requires base coordinates or explicit clients`)
  }
  const latitude = zone.latitude
  const longitude = zone.longitude
  return CLIENT_OFFSETS.map((offset) => ({
    latitude: Number((latitude + offset.latitudeDelta).toFixed(6)),
    longitude: Number((longitude + offset.longitudeDelta).toFixed(6))
  }))
}

const fixtureObjectId = (key: string): Types.ObjectId =>
  new Types.ObjectId(createHash('sha256').update(`${FIXTURE_NAMESPACE}:${key}`).digest('hex').slice(0, 24))

const resolveMongoUri = (): string => {
  const override = process.env.MONGODB_URI
  const uri = override === undefined || override.trim() === '' ? DEFAULT_MONGO_URI : override.trim()

  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    throw new Error(`MONGODB_URI is not a valid connection string: ${uri}`)
  }

  const database = parsed.pathname.replace(/^\/+/, '')
  const isLocalHost = ALLOWED_HOSTS.includes(parsed.hostname.toLowerCase())
  if (parsed.protocol !== 'mongodb:' || !isLocalHost || database !== TARGET_DATABASE) {
    throw new Error(`Refusing to seed ${uri}: only localhost/127.0.0.1 targeting database ${TARGET_DATABASE} is allowed`)
  }
  return uri
}

const resolveServiceDate = (): { serviceDate: string, serviceDateInstant: Date } => {
  const raw = process.env.ROUTE_PLAN_SERVICE_DATE ?? DEFAULT_SERVICE_DATE
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`ROUTE_PLAN_SERVICE_DATE must be a YYYY-MM-DD civil date, received: ${raw}`)
  }

  const [year, month, day] = raw.split('-').map(Number)
  const probe = new Date(Date.UTC(year, month - 1, day))
  const isRealDate = probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
  if (!isRealDate) {
    throw new Error(`ROUTE_PLAN_SERVICE_DATE must be a real calendar date, received: ${raw}`)
  }

  return { serviceDate: raw, serviceDateInstant: fromZonedTime(`${raw}T00:00:00`, SERVICE_TIME_ZONE) }
}

const resolveTestPassword = (): string => {
  const override = process.env.ROUTE_PLAN_TEST_PASSWORD
  return override === undefined || override === '' ? DEFAULT_TEST_PASSWORD : override
}

const createSummary = (): SeedSummary => ({
  routeTestRole: { inserted: 0, updated: 0 },
  routeTestUser: { inserted: 0, updated: 0 },
  deliveryZones: { inserted: 0, updated: 0 },
  clients: { inserted: 0, updated: 0 },
  sales: { inserted: 0, updated: 0 },
  routingConfigs: { inserted: 0, updated: 0 },
  vehicles: { inserted: 0, updated: 0 },
  routeSnapshots: { inserted: 0, updated: 0 }
})

const addOutcome = (group: GroupCount, outcome: FixtureOutcome): void => {
  group[outcome] += 1
}

const upsertRouteTestRole = async (id: Types.ObjectId): Promise<FixtureOutcome> => {
  const payload = {
    name: ROUTE_TEST_ROLE_NAME,
    description: 'Role used by route optimization test fixtures',
    permissions: ROUTE_TEST_PERMISSIONS,
    isActive: true
  }

  const existing = await RoleModel.findById(id)
  if (existing === null) {
    await RoleModel.create({ _id: id, ...payload })
    return 'inserted'
  }
  existing.set(payload)
  await existing.save()
  return 'updated'
}

const upsertRouteTestUser = async (id: Types.ObjectId, roleId: Types.ObjectId, passwordHash: string): Promise<FixtureOutcome> => {
  const payload = {
    nickname: ROUTE_TEST_USER_NICKNAME,
    email: `${ROUTE_TEST_USER_NICKNAME}@route-plan.test`,
    password: passwordHash,
    role: roleId,
    isActive: true
  }

  const existing = await UserModel.findById(id)
  if (existing === null) {
    await UserModel.create({ _id: id, ...payload })
    return 'inserted'
  }
  existing.set(payload)
  await existing.save()
  return 'updated'
}

const upsertDeliveryZone = async (id: Types.ObjectId, fixture: ZoneFixture): Promise<FixtureOutcome> => {
  const payload = {
    code: fixture.code,
    name: fixture.name,
    normalizedName: fixture.name.trim().toLowerCase(),
    active: true
  }

  const existing = await DeliveryZoneModel.findById(id)
  if (existing === null) {
    await DeliveryZoneModel.create({ _id: id, ...payload })
    return 'inserted'
  }
  existing.set(payload)
  await existing.save()
  return 'updated'
}

const upsertClient = async (fixture: ClientFixture): Promise<FixtureOutcome> => {
  const geocoding: {
    status: GeocodingStatus
    source: GeocodingSource
    formattedAddress: string
    precision?: GeocodingPrecision
    validatedAt?: Date
    validatedBy?: Types.ObjectId
  } = {
    status: fixture.geocodingStatus,
    source: fixture.geocodingSource,
    formattedAddress: fixture.address
  }

  if (fixture.geocodingStatus === GEOCODING_STATUS.CONFIRMED) {
    geocoding.precision = GEOCODING_PRECISION.ROOFTOP
    geocoding.validatedAt = FIXTURE_VALIDATED_AT
    geocoding.validatedBy = fixture.validatedBy
  }

  const payload = {
    nombreCompleto: fixture.nombreCompleto,
    address: fixture.address,
    telefonos: [fixture.telefono],
    lat: fixture.latitude,
    lng: fixture.longitude,
    deliveryZoneId: fixture.deliveryZoneId,
    isActive: fixture.isActive,
    geocoding
  }

  const existing = await ClientModel.findById(fixture.id)
  if (existing === null) {
    await ClientModel.create({ _id: fixture.id, ...payload })
    return 'inserted'
  }
  existing.set(payload)
  await existing.save()
  return 'updated'
}

const upsertSale = async (fixture: SaleFixture): Promise<FixtureOutcome> => {
  const payload = {
    estado: SALE_ESTADO_CREATED,
    total: fixture.total,
    user: fixture.userId,
    cliente: fixture.clientName,
    idCliente: fixture.clientId,
    delivery: { status: SALE_DELIVERY_STATUS.PENDING, serviceDate: fixture.serviceDateInstant }
  }

  const existing = await SaleModel.findById(fixture.id)
  if (existing === null) {
    await SaleModel.create({ _id: fixture.id, ...payload })
    return 'inserted'
  }
  existing.set(payload)
  await existing.save()
  return 'updated'
}

const upsertRoutingConfig = async (id: Types.ObjectId, updatedBy: Types.ObjectId): Promise<FixtureOutcome> => {
  const payload = {
    key: ROUTING_CONFIG_KEYS.DEPOSITO_1,
    enabled: true,
    revision: 1,
    depot: { ...DEPOT_FIXTURE },
    fuelConsumptionLitersPer100Km: FUEL_COEFFICIENT,
    maxStops: MAX_STOPS,
    provider: ROUTE_MODES.GOOGLE_ROUTES,
    algorithm: DEFAULT_ROUTE_ALGORITHM,
    updatedBy
  }

  const existing = await RoutingConfigModel.findById(id)
  if (existing === null) {
    await RoutingConfigModel.create({ _id: id, ...payload })
    return 'inserted'
  }
  const { key, ...mutablePayload } = payload
  existing.set(mutablePayload)
  await existing.save()
  return 'updated'
}

const upsertRouteTestVehicle = async (id: Types.ObjectId, fixture: (typeof ROUTE_TEST_VEHICLES)[number]): Promise<FixtureOutcome> => {
  const payload = {
    code: fixture.code,
    fuelConsumptionLitersPer100Km: fixture.fuel,
    attributes: { fixture: 'route-plan-test', capacity: 'demo' },
    active: true
  }

  const existing = await VehicleModel.findById(id)
  if (existing === null) {
    await VehicleModel.create({ _id: id, ...payload })
    return 'inserted'
  }
  existing.set(payload)
  await existing.save()
  return 'updated'
}

const haversineDistanceMeters = (from: RoutePoint, to: RoutePoint): number => {
  const earthRadiusMeters = 6371000
  const latitudeDelta = (to.latitude - from.latitude) * Math.PI / 180
  const longitudeDelta = (to.longitude - from.longitude) * Math.PI / 180
  const latitudeFrom = from.latitude * Math.PI / 180
  const latitudeTo = to.latitude * Math.PI / 180
  const a = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(latitudeFrom) * Math.cos(latitudeTo) * Math.sin(longitudeDelta / 2) ** 2
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * ROUTE_DISTANCE_FACTOR
}

const buildRouteSegments = (stops: RoutePlanStop[], depot: RoutingDepot): { segments: RoutePlanSegment[], distanceMeters: number, durationSeconds: number } => {
  const points: RoutePoint[] = [depot, ...stops, depot]
  const segments: RoutePlanSegment[] = []
  let distanceMeters = 0
  let durationSeconds = 0

  for (let index = 0; index < points.length - 1; index += 1) {
    const segmentDistance = Math.round(haversineDistanceMeters(points[index], points[index + 1]))
    const segmentDuration = Math.round(segmentDistance / (ROUTE_ESTIMATE_SPEED_KMH * 1000 / 3600))
    distanceMeters += segmentDistance
    durationSeconds += segmentDuration
    segments.push({
      fromStopSequence: index,
      toStopSequence: index === points.length - 2 ? 0 : index + 1,
      distanceMeters: segmentDistance,
      durationSeconds: segmentDuration
    })
  }

  return { segments, distanceMeters, durationSeconds }
}

const encodePolyline = (points: RoutePoint[]): string => {
  let previousLatitude = 0
  let previousLongitude = 0
  let encoded = ''
  const encodeValue = (value: number): string => {
    let shifted = value < 0 ? ~(value << 1) : value << 1
    let result = ''
    while (shifted >= 0x20) {
      result += String.fromCharCode((0x20 | (shifted & 0x1f)) + 63)
      shifted >>= 5
    }
    return result + String.fromCharCode(shifted + 63)
  }

  for (const point of points) {
    const latitude = Math.round(point.latitude * 1e5)
    const longitude = Math.round(point.longitude * 1e5)
    encoded += encodeValue(latitude - previousLatitude)
    encoded += encodeValue(longitude - previousLongitude)
    previousLatitude = latitude
    previousLongitude = longitude
  }
  return encoded
}

const buildRouteSnapshot = (serviceDateInstant: Date, userId: Types.ObjectId, vehicleId: Types.ObjectId, routeIndex: number, clientFixtures: ClientFixture[], saleFixtures: SaleFixture[]): RoutePlan => {
  const depot = DEPOT_FIXTURE
  const stops: RoutePlanStop[] = clientFixtures.map((client, index) => ({
    clientId: String(client.id),
    saleIds: [String(saleFixtures[index].id)],
    sequence: index + 1,
    latitude: client.latitude,
    longitude: client.longitude
  }))
  const route = buildRouteSegments(stops, depot)
  const totalDurationWithStops = route.durationSeconds + stops.length * ROUTE_STOP_SERVICE_SECONDS
  const scheduleAssumptions: RouteScheduleAssumptions = {
    calculatedAt: serviceDateInstant,
    timezone: SERVICE_TIME_ZONE,
    source: 'deterministic-test-fixture'
  }
  const stopEstimates: RouteStopEstimate[] = []
  let cumulativeDurationSeconds = 0
  for (let index = 0; index < stops.length; index += 1) {
    cumulativeDurationSeconds += route.segments[index].durationSeconds + ROUTE_STOP_SERVICE_SECONDS
    stopEstimates.push({
      sequence: stops[index].sequence,
      arrival: new Date(serviceDateInstant.getTime() + cumulativeDurationSeconds * 1000),
      cumulativeDurationSeconds,
      calculatedAt: serviceDateInstant,
      timezone: SERVICE_TIME_ZONE,
      availability: ROUTE_METRIC_AVAILABILITY.ESTIMATED
    })
  }
  const saleReferences: RouteSnapshotSaleReference[] = saleFixtures.map((sale) => ({
    saleId: String(sale.id),
    versionAtSave: null,
    statusAtSave: SALE_DELIVERY_STATUS.PENDING
  }))
  const fuelLiters = route.distanceMeters / 100000 * ROUTE_TEST_VEHICLE_FUEL
  const fuelAssumptions: RouteFuelAssumptions = {
    availability: ROUTE_METRIC_AVAILABILITY.CALCULATED,
    consumptionLitersPer100Km: ROUTE_TEST_VEHICLE_FUEL,
    distanceKm: route.distanceMeters / 1000,
    vehicleCode: ROUTE_TEST_VEHICLE_CODE,
    source: 'deterministic-test-fixture',
    calculatedAt: serviceDateInstant
  }
  const points: RoutePoint[] = [depot, ...stops, depot]

  return {
    _id: fixtureObjectId(`route-snapshot:TEST_ROUTE:${serviceDateInstant.toISOString()}:${routeIndex}`),
    snapshotVersion: 1,
    planningDate: serviceDateInstant,
    zoneSnapshot: { code: 'TEST_ROUTE', normalizedName: 'test-route', name: 'Test-Route' },
    selectedSaleIds: saleFixtures.map((sale) => String(sale.id)),
    depot,
    stops,
    segments: route.segments,
    metrics: {
      distanceMeters: route.distanceMeters,
      durationSeconds: totalDurationWithStops,
      stopCount: stops.length,
      fuelLiters,
      availability: ROUTE_METRIC_AVAILABILITY.ESTIMATED
    },
    algorithm: { name: DEFAULT_ROUTE_ALGORITHM, version: DEFAULT_ROUTE_ALGORITHM, provider: ROUTE_MODES.GOOGLE_ROUTES },
    routingConfigRevision: 1,
    ruleVersion: CANDIDATE_RULE_VERSION,
    encodedPolyline: encodePolyline(points),
    warnings: ['DEMO_ESTIMATED_ROUTE_METRICS'],
    audit: { createdBy: String(userId), createdAt: serviceDateInstant },
    assignments: { driverId: String(userId), vehicleId: String(vehicleId) },
    fuelAssumptions,
    scheduleAssumptions,
    stopEstimates,
    saleReferences
  }
}

const createRouteSnapshots = async (serviceDateInstant: Date, userId: Types.ObjectId, vehicleId: Types.ObjectId, clientFixtures: ClientFixture[], saleFixtures: SaleFixture[], summary: GroupCount): Promise<void> => {
  const partitions = [[0, 1, 2, 3], [4, 5], [6, 7]]
  for (let routeIndex = 0; routeIndex < partitions.length; routeIndex += 1) {
    const indexes = partitions[routeIndex]
    const snapshot = buildRouteSnapshot(serviceDateInstant, userId, vehicleId, routeIndex + 1, indexes.map((index) => clientFixtures[index]), indexes.map((index) => saleFixtures[index]))
    const existing = await RoutePlanModel.findById(snapshot._id)
    if (existing === null) {
      await RoutePlanModel.create(snapshot)
      addOutcome(summary, 'inserted')
    }
  }
}

const seed = async (): Promise<SeedResult> => {
  const uri = resolveMongoUri()
  const { serviceDate, serviceDateInstant } = resolveServiceDate()
  const testPassword = resolveTestPassword()
  const summary = createSummary()
  const database = new URL(uri).pathname.replace(/^\/+/, '')

  await mongoose.connect(uri)
  try {
    const passwordHash = await encrypt(testPassword)

    const roleId = fixtureObjectId('role:route-test')
    addOutcome(summary.routeTestRole, await upsertRouteTestRole(roleId))

    const userId = fixtureObjectId('user:route-test')
    addOutcome(summary.routeTestUser, await upsertRouteTestUser(userId, roleId, passwordHash))

    const zoneIds = new Map<string, Types.ObjectId>()
    for (const zone of ZONE_FIXTURES) {
      const zoneId = fixtureObjectId(`zone:${zone.key}`)
      zoneIds.set(zone.key, zoneId)
      addOutcome(summary.deliveryZones, await upsertDeliveryZone(zoneId, zone))
    }

    let clientIndex = 0
    const testRouteClients: ClientFixture[] = []
    const testRouteSales: SaleFixture[] = []
    for (const zone of ZONE_FIXTURES) {
      const zoneId = zoneIds.get(zone.key)
      if (zoneId === undefined) throw new Error(`Missing seeded delivery zone for ${zone.key}`)

      const coordinates = buildZoneClientCoordinates(zone)
      for (let index = 0; index < coordinates.length; index += 1) {
        const coordinate = coordinates[index]
        clientIndex += 1
        const clientName = `Cliente de prueba ${zone.name} ${index + 1}`
        const clientId = fixtureObjectId(`client:${zone.key}:${index + 1}`)
        const clientFixture: ClientFixture = {
          id: clientId,
          nombreCompleto: clientName,
          address: `Calle Ficticia ${100 + index}, ${zone.name}`,
          telefono: TEST_PHONE_BASE + clientIndex,
          latitude: coordinate.latitude,
          longitude: coordinate.longitude,
          deliveryZoneId: zoneId,
          isActive: true,
          geocodingStatus: GEOCODING_STATUS.CONFIRMED,
          geocodingSource: GEOCODING_SOURCE.MANUAL,
          validatedBy: userId
        }
        addOutcome(summary.clients, await upsertClient(clientFixture))
        const saleFixture: SaleFixture = {
          id: fixtureObjectId(`sale:${zone.key}:${index + 1}`),
          userId,
          clientId,
          clientName,
          total: SALE_TOTAL_BASE + clientIndex * SALE_TOTAL_STEP,
          serviceDateInstant
        }
        addOutcome(summary.sales, await upsertSale(saleFixture))
        if (zone.code === 'TEST_ROUTE') {
          testRouteClients.push(clientFixture)
          testRouteSales.push(saleFixture)
        }
      }
    }

    // Blocked fixture: active client inside a valid zone but with unconfirmed
    // geocoding, so the candidate query reports CLIENT_LOCATION_UNCONFIRMED.
    const blockedZone = ZONE_FIXTURES[0]
    const blockedZoneId = zoneIds.get(blockedZone.key)
    if (blockedZoneId === undefined) throw new Error(`Missing seeded delivery zone for ${blockedZone.key}`)
    if (blockedZone.latitude === undefined || blockedZone.longitude === undefined) {
      throw new Error(`Blocked fixture zone ${blockedZone.key} requires base coordinates`)
    }
    const blockedLatitude = blockedZone.latitude
    const blockedLongitude = blockedZone.longitude

    const blockedClientName = `Cliente bloqueado ${blockedZone.name}`
    const blockedClientId = fixtureObjectId('client:blocked')
    addOutcome(summary.clients, await upsertClient({
      id: blockedClientId,
      nombreCompleto: blockedClientName,
      address: `Calle Ficticia 200, ${blockedZone.name}`,
      telefono: TEST_PHONE_BASE + 900,
      latitude: blockedLatitude + 0.0043,
      longitude: blockedLongitude - 0.0038,
      deliveryZoneId: blockedZoneId,
      isActive: true,
      geocodingStatus: GEOCODING_STATUS.UNVERIFIED,
      geocodingSource: GEOCODING_SOURCE.GEOCODED
    }))
    addOutcome(summary.sales, await upsertSale({
      id: fixtureObjectId('sale:blocked'),
      userId,
      clientId: blockedClientId,
      clientName: blockedClientName,
      total: SALE_TOTAL_BASE + 1000,
      serviceDateInstant
    }))

    addOutcome(summary.routingConfigs, await upsertRoutingConfig(fixtureObjectId('routing-config:deposito_1'), userId))
    const vehicleIds = ROUTE_TEST_VEHICLES.map((fixture) => fixtureObjectId(`vehicle:${fixture.key}`))
    for (let index = 0; index < ROUTE_TEST_VEHICLES.length; index += 1) {
      addOutcome(summary.vehicles, await upsertRouteTestVehicle(vehicleIds[index], ROUTE_TEST_VEHICLES[index]))
    }
    const vehicleId = vehicleIds[0]
    if (testRouteClients.length !== 8 || testRouteSales.length !== 8) throw new Error('TEST_ROUTE fixture must contain exactly 8 clients and sales')
    await createRouteSnapshots(serviceDateInstant, userId, vehicleId, testRouteClients, testRouteSales, summary.routeSnapshots)
  } finally {
    await mongoose.disconnect()
  }

  return { database, serviceDate, serviceDateInstant, summary }
}

const formatGroup = (group: GroupCount): string => `${group.inserted} inserted, ${group.updated} updated`

const printSummary = (result: SeedResult): void => {
  const lines = [
    'Route plan test data seed completed',
    `database: ${result.database}`,
    `serviceDate: ${result.serviceDate} (${result.serviceDateInstant.toISOString()})`,
    `routeTestRole: ${formatGroup(result.summary.routeTestRole)}`,
    `routeTestUser: ${formatGroup(result.summary.routeTestUser)}`,
    `deliveryZones: ${formatGroup(result.summary.deliveryZones)}`,
    `clients: ${formatGroup(result.summary.clients)}`,
    `sales: ${formatGroup(result.summary.sales)}`,
    `routingConfigs: ${formatGroup(result.summary.routingConfigs)}`,
    `vehicles: ${formatGroup(result.summary.vehicles)}`,
    `routeSnapshots: ${formatGroup(result.summary.routeSnapshots)}`
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
}

if (require.main === module) {
  void seed()
    .then((result) => {
      printSummary(result)
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'Route plan test seed failed'}\n`)
      process.exitCode = 1
    })
}
