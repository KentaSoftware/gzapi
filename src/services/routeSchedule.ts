import {
  ROUTE_METRIC_AVAILABILITY,
  type RoutePreview,
  type RouteStopEstimate
} from '../interfaces/routeOptimization.interface'

const isFiniteNonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0

const calculateStopEstimates = (route: RoutePreview, calculatedAt: Date, timezone: string): RouteStopEstimate[] => {
  if (!Number.isFinite(calculatedAt.getTime())) throw new RangeError('Schedule calculation requires a valid calculation date')
  if (timezone.trim() === '') throw new RangeError('Schedule calculation requires a timezone')
  if (route.route.segments.length < route.route.stops.length) throw new RangeError('Schedule route is missing stop segments')

  const frozenCalculatedAt = new Date(calculatedAt.getTime())
  let cumulativeDurationSeconds = 0

  return route.route.stops.map((_stop, index) => {
    const segment = route.route.segments[index]
    if (segment === undefined || !isFiniteNonNegative(segment.durationSeconds)) {
      throw new RangeError('Schedule segments require finite non-negative durations')
    }

    cumulativeDurationSeconds += segment.durationSeconds
    return {
      sequence: index + 1,
      arrival: new Date(frozenCalculatedAt.getTime() + cumulativeDurationSeconds * 1000),
      cumulativeDurationSeconds,
      calculatedAt: new Date(frozenCalculatedAt.getTime()),
      timezone,
      availability: ROUTE_METRIC_AVAILABILITY.CALCULATED
    }
  })
}

export { calculateStopEstimates }
