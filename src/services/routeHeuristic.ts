import type {
  RouteHeuristicInput,
  RouteHeuristicResult,
  RouteMatrixSegment
} from '../interfaces/routeOptimization.interface'

type RouteInvariantCode = 'INVALID_ROUTE_INPUT' | 'ROUTE_MATRIX_INCOMPLETE'

class RouteInvariantError extends Error {
  readonly code: RouteInvariantCode

  constructor (code: RouteInvariantCode, message: string) {
    super(message)
    this.name = 'RouteInvariantError'
    this.code = code
  }
}

const pairKey = (fromId: string, toId: string): string => `${fromId}\u0000${toId}`

const isFiniteNonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0

const assertValidLocation = (id: string, latitude: number, longitude: number): void => {
  if (id.trim() === '' || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new RouteInvariantError('INVALID_ROUTE_INPUT', 'Route locations require an identifier and finite coordinates')
  }
}

const validateRouteInput = (input: RouteHeuristicInput): void => {
  assertValidLocation(input.depot.id, input.depot.latitude, input.depot.longitude)

  const clientIds = new Set<string>()
  const saleIds = new Set<string>()
  for (const stop of input.stops) {
    assertValidLocation(stop.clientId, stop.latitude, stop.longitude)
    if (stop.clientId === input.depot.id || clientIds.has(stop.clientId)) {
      throw new RouteInvariantError('INVALID_ROUTE_INPUT', 'Route stops must have unique client identifiers')
    }
    clientIds.add(stop.clientId)
    if (stop.saleIds.length === 0) {
      throw new RouteInvariantError('INVALID_ROUTE_INPUT', 'Each route stop requires at least one sale identifier')
    }
    for (const saleId of stop.saleIds) {
      if (saleId.trim() === '' || saleIds.has(saleId)) {
        throw new RouteInvariantError('INVALID_ROUTE_INPUT', 'Route stops must have unique sale identifiers')
      }
      saleIds.add(saleId)
    }
  }

  const pairs = new Set<string>()
  for (const segment of input.matrix) {
    if (segment.fromId.trim() === '' || segment.toId.trim() === '' || segment.fromId === segment.toId || !isFiniteNonNegative(segment.distanceMeters) || !isFiniteNonNegative(segment.durationSeconds)) {
      throw new RouteInvariantError('INVALID_ROUTE_INPUT', 'Route matrix segments require distinct endpoints and finite non-negative values')
    }
    const key = pairKey(segment.fromId, segment.toId)
    if (pairs.has(key)) {
      throw new RouteInvariantError('INVALID_ROUTE_INPUT', 'Route matrix segments must not duplicate pairs')
    }
    pairs.add(key)
  }

  const locationIds = [input.depot.id, ...input.stops.map((stop) => stop.clientId)]
  const missingPairs: string[] = []
  for (const fromId of locationIds) {
    for (const toId of locationIds) {
      if (fromId !== toId && !pairs.has(pairKey(fromId, toId))) missingPairs.push(`${fromId}->${toId}`)
    }
  }
  if (missingPairs.length > 0) {
    throw new RouteInvariantError('ROUTE_MATRIX_INCOMPLETE', `Route matrix is missing pairs: ${missingPairs.join(', ')}`)
  }
}

const matrixByPair = (matrix: RouteMatrixSegment[]): Map<string, RouteMatrixSegment> => new Map(matrix.map((segment) => [pairKey(segment.fromId, segment.toId), segment]))

const segmentFor = (matrix: Map<string, RouteMatrixSegment>, fromId: string, toId: string): RouteMatrixSegment => {
  const segment = matrix.get(pairKey(fromId, toId))
  if (segment === undefined) throw new RouteInvariantError('ROUTE_MATRIX_INCOMPLETE', `Route matrix is missing pair: ${fromId}->${toId}`)
  return segment
}

const compareSegments = (left: RouteMatrixSegment, right: RouteMatrixSegment): number => {
  if (left.distanceMeters !== right.distanceMeters) return left.distanceMeters - right.distanceMeters
  if (left.durationSeconds !== right.durationSeconds) return left.durationSeconds - right.durationSeconds
  return left.toId.localeCompare(right.toId)
}

const routeMetrics = (routeIds: string[], matrix: Map<string, RouteMatrixSegment>): { distanceMeters: number, durationSeconds: number } => {
  const closedIds = [routeIds[0], ...routeIds.slice(1), routeIds[0]]
  return closedIds.slice(1).reduce((metrics, toId, index) => {
    const segment = segmentFor(matrix, closedIds[index], toId)
    return {
      distanceMeters: metrics.distanceMeters + segment.distanceMeters,
      durationSeconds: metrics.durationSeconds + segment.durationSeconds
    }
  }, { distanceMeters: 0, durationSeconds: 0 })
}

const compareRoutes = (left: string[], right: string[], matrix: Map<string, RouteMatrixSegment>): number => {
  const leftMetrics = routeMetrics(left, matrix)
  const rightMetrics = routeMetrics(right, matrix)
  if (leftMetrics.distanceMeters !== rightMetrics.distanceMeters) return leftMetrics.distanceMeters - rightMetrics.distanceMeters
  if (leftMetrics.durationSeconds !== rightMetrics.durationSeconds) return leftMetrics.durationSeconds - rightMetrics.durationSeconds
  return left.slice(1).join('\u0000').localeCompare(right.slice(1).join('\u0000'))
}

const nearestNeighborRoute = (input: RouteHeuristicInput, matrix: Map<string, RouteMatrixSegment>): string[] => {
  const remaining = new Set(input.stops.map((stop) => stop.clientId))
  const routeIds = [input.depot.id]
  let currentId = input.depot.id
  while (remaining.size > 0) {
    const candidates = [...remaining]
      .map((clientId) => segmentFor(matrix, currentId, clientId))
      .sort(compareSegments)
    const next = candidates[0]
    routeIds.push(next.toId)
    remaining.delete(next.toId)
    currentId = next.toId
  }
  return routeIds
}

const twoOpt = (initialRoute: string[], matrix: Map<string, RouteMatrixSegment>): string[] => {
  let route = initialRoute
  let improved = true
  while (improved) {
    improved = false
    for (let start = 1; start < route.length - 1 && !improved; start += 1) {
      for (let end = start + 1; end < route.length; end += 1) {
        const candidate = [...route.slice(0, start), ...route.slice(start, end + 1).reverse(), ...route.slice(end + 1)]
        if (compareRoutes(candidate, route, matrix) < 0) {
          route = candidate
          improved = true
          break
        }
      }
    }
  }
  return route
}

const buildClosedRoute = (input: RouteHeuristicInput): RouteHeuristicResult => {
  validateRouteInput(input)
  const matrix = matrixByPair(input.matrix)
  const routeIds = twoOpt(nearestNeighborRoute(input, matrix), matrix)
  const stopsByClientId = new Map(input.stops.map((stop) => [stop.clientId, stop]))
  const orderedStops = routeIds.slice(1).map((clientId) => {
    const stop = stopsByClientId.get(clientId)
    if (stop === undefined) throw new RouteInvariantError('INVALID_ROUTE_INPUT', `Route stop is missing for client: ${clientId}`)
    return { ...stop, saleIds: [...stop.saleIds] }
  })
  const closedIds = [...routeIds, input.depot.id]
  const segments = closedIds.slice(1).map((toId, index) => ({ ...segmentFor(matrix, closedIds[index], toId) }))
  const { distanceMeters, durationSeconds } = routeMetrics(routeIds, matrix)
  return { orderedStops, segments, distanceMeters, durationSeconds }
}

const calculateFuelLiters = (distanceKm: number, litersPer100Km: number): number => {
  if (!isFiniteNonNegative(distanceKm) || !isFiniteNonNegative(litersPer100Km)) {
    throw new RouteInvariantError('INVALID_ROUTE_INPUT', 'Fuel calculation requires finite non-negative values')
  }
  return Number((distanceKm * litersPer100Km / 100).toFixed(12))
}

export {
  buildClosedRoute,
  calculateFuelLiters,
  RouteInvariantError,
  validateRouteInput
}
