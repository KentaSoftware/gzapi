import axios from 'axios'
import type {
  FinalRoute,
  FinalRouteRequest,
  RouteLocation,
  RouteMatrix,
  RouteMatrixRequest,
  RouteMatrixSegment
} from '../interfaces/routeOptimization.interface'

type RouteProviderErrorCode =
  | 'INVALID_ROUTE_INPUT'
  | 'ROUTE_MATRIX_INCOMPLETE'
  | 'ROUTE_FINAL_ROUTE_INVALID'
  | 'ROUTING_PROVIDER_QUOTA_EXCEEDED'
  | 'ROUTING_PROVIDER_REQUEST_REJECTED'
  | 'ROUTING_PROVIDER_UNAVAILABLE'

interface GoogleMatrixElement {
  originIndex?: unknown
  destinationIndex?: unknown
  condition?: unknown
  distanceMeters?: unknown
  duration?: unknown
}

interface GoogleRoute {
  distanceMeters?: unknown
  duration?: unknown
  polyline?: {
    encodedPolyline?: unknown
  }
}

interface GoogleRoutesResponse {
  routes?: unknown
}

interface GoogleWaypoint {
  waypoint: {
    location: {
      latLng: {
        latitude: number
        longitude: number
      }
    }
  }
}

class RouteProviderError extends Error {
  readonly code: RouteProviderErrorCode

  constructor (code: RouteProviderErrorCode, message: string) {
    super(message)
    this.name = 'RouteProviderError'
    this.code = code
  }
}

const MATRIX_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix'
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes'
const DEFAULT_TIMEOUT_MS = 5000

const timeoutMs = (): number => {
  const configured = Number(process.env.GOOGLE_ROUTES_TIMEOUT_MS)
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS
}

const apiKey = (): string => {
  const key = process.env.GOOGLE_MAPS_SERVER_API_KEY
  if (typeof key !== 'string' || key.trim() === '') {
    throw new RouteProviderError('ROUTING_PROVIDER_UNAVAILABLE', 'Google Routes provider is not configured')
  }
  return key
}

const assertLocation = (location: RouteLocation): void => {
  if (location.id.trim() === '' || location.name.trim() === '' || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude) || location.latitude < -90 || location.latitude > 90 || location.longitude < -180 || location.longitude > 180) {
    throw new RouteProviderError('INVALID_ROUTE_INPUT', 'Route locations require identifiers, names, and valid coordinates')
  }
}

const assertLocations = (locations: RouteLocation[]): void => {
  if (locations.length === 0) throw new RouteProviderError('INVALID_ROUTE_INPUT', 'Route requests require at least one location')
  const ids = new Set<string>()
  for (const location of locations) {
    assertLocation(location)
    if (ids.has(location.id)) throw new RouteProviderError('INVALID_ROUTE_INPUT', 'Route locations must have unique identifiers')
    ids.add(location.id)
  }
}

const toGoogleWaypoint = (location: RouteLocation): GoogleWaypoint => ({
  waypoint: {
    location: {
      latLng: {
        latitude: location.latitude,
        longitude: location.longitude
      }
    }
  }
})

const durationSeconds = (value: unknown): number | undefined => {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?s$/.test(value)) return undefined
  const seconds = Number(value.slice(0, -1))
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

const isTransient = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return true
  const response = (error as { response?: { status?: unknown } }).response
  if (response === undefined) return true
  return typeof response.status === 'number' && response.status >= 500
}

const providerError = (error: unknown): RouteProviderError => {
  if (error instanceof RouteProviderError) return error
  const response = typeof error === 'object' && error !== null
    ? (error as { response?: { status?: unknown, data?: { error?: { status?: unknown } } } }).response
    : undefined
  const status = response?.status
  const providerStatus = response?.data?.error?.status
  if (status === 429 || providerStatus === 'RESOURCE_EXHAUSTED') {
    return new RouteProviderError('ROUTING_PROVIDER_QUOTA_EXCEEDED', 'Google Routes provider quota is exhausted')
  }
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return new RouteProviderError('ROUTING_PROVIDER_REQUEST_REJECTED', 'Google Routes provider rejected the request')
  }
  return new RouteProviderError('ROUTING_PROVIDER_UNAVAILABLE', 'Google Routes provider is unavailable')
}

const postWithRetry = async <T>(url: string, data: object, fieldMask: string): Promise<T> => {
  const key = apiKey()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await axios.post<T>(url, data, {
        timeout: timeoutMs(),
        headers: {
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': fieldMask,
          'Content-Type': 'application/json'
        }
      })
      return response.data
    } catch (error) {
      if (attempt === 0 && isTransient(error)) continue
      throw providerError(error)
    }
  }
  throw new RouteProviderError('ROUTING_PROVIDER_UNAVAILABLE', 'Google Routes provider is unavailable')
}

const normalizeMatrix = (elements: unknown, origins: RouteLocation[], destinations: RouteLocation[]): RouteMatrix => {
  if (!Array.isArray(elements)) throw new RouteProviderError('ROUTE_MATRIX_INCOMPLETE', 'Google Routes matrix response is invalid')
  const expected = new Set<string>()
  for (const origin of origins) {
    for (const destination of destinations) {
      if (origin.id !== destination.id) expected.add(`${origin.id}\u0000${destination.id}`)
    }
  }

  const segments: RouteMatrixSegment[] = []
  const received = new Set<string>()
  for (const element of elements) {
    if (typeof element !== 'object' || element === null) continue
    const { originIndex, destinationIndex, condition, distanceMeters, duration } = element as GoogleMatrixElement
    if (typeof originIndex !== 'number' || typeof destinationIndex !== 'number' || !Number.isInteger(originIndex) || !Number.isInteger(destinationIndex) || originIndex < 0 || destinationIndex < 0 || originIndex >= origins.length || destinationIndex >= destinations.length) continue
    const origin = origins[originIndex]
    const destination = destinations[destinationIndex]
    const key = `${origin.id}\u0000${destination.id}`
    const seconds = durationSeconds(duration)
    if (origin.id === destination.id) continue
    if (condition !== 'ROUTE_EXISTS' || typeof distanceMeters !== 'number' || !Number.isFinite(distanceMeters) || distanceMeters < 0 || seconds === undefined || received.has(key)) continue
    received.add(key)
    segments.push({ fromId: origin.id, toId: destination.id, distanceMeters, durationSeconds: seconds })
  }

  if (received.size !== expected.size || [...expected].some((key) => !received.has(key))) {
    throw new RouteProviderError('ROUTE_MATRIX_INCOMPLETE', 'Google Routes matrix response is incomplete')
  }
  return { segments }
}

const normalizeFinalRoute = (response: GoogleRoutesResponse): FinalRoute => {
  if (!Array.isArray(response.routes) || response.routes.length !== 1 || typeof response.routes[0] !== 'object' || response.routes[0] === null) {
    throw new RouteProviderError('ROUTE_FINAL_ROUTE_INVALID', 'Google Routes final route response is invalid')
  }
  const route = response.routes[0] as GoogleRoute
  const seconds = durationSeconds(route.duration)
  if (typeof route.distanceMeters !== 'number' || !Number.isFinite(route.distanceMeters) || route.distanceMeters < 0 || seconds === undefined || typeof route.polyline?.encodedPolyline !== 'string' || route.polyline.encodedPolyline === '') {
    throw new RouteProviderError('ROUTE_FINAL_ROUTE_INVALID', 'Google Routes final route response is invalid')
  }
  return { encodedPolyline: route.polyline.encodedPolyline, distanceMeters: route.distanceMeters, durationSeconds: seconds }
}

const computeMatrix = async ({ origins, destinations }: RouteMatrixRequest): Promise<RouteMatrix> => {
  assertLocations(origins)
  assertLocations(destinations)
  const elements = await postWithRetry<unknown>(MATRIX_URL, {
    origins: origins.map(toGoogleWaypoint),
    destinations: destinations.map(toGoogleWaypoint),
    travelMode: 'DRIVE'
  }, 'originIndex,destinationIndex,condition,distanceMeters,duration')
  return normalizeMatrix(elements, origins, destinations)
}

const computeRoute = async ({ origin, intermediates, destination }: FinalRouteRequest): Promise<FinalRoute> => {
  assertLocation(origin)
  assertLocations(intermediates)
  assertLocation(destination)
  const response = await postWithRetry<GoogleRoutesResponse>(ROUTES_URL, {
    origin: toGoogleWaypoint(origin).waypoint,
    intermediates: intermediates.map((location) => toGoogleWaypoint(location).waypoint),
    destination: toGoogleWaypoint(destination).waypoint,
    travelMode: 'DRIVE'
  }, 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline')
  return normalizeFinalRoute(response)
}

export {
  computeMatrix,
  computeRoute,
  RouteProviderError
}
