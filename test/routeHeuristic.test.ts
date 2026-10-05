import { expect } from 'chai'
import {
  buildClosedRoute,
  calculateFuelLiters,
  RouteInvariantError,
  validateRouteInput
} from '../src/services/routeHeuristic'
import type { RouteHeuristicInput, RouteMatrixSegment, RouteStop } from '../src/interfaces/routeOptimization.interface'

const depot = { id: 'depot', name: 'Depot', latitude: -34.6, longitude: -58.4 }

const stop = (clientId: string, saleIds: string[] = [`sale-${clientId}`]): RouteStop => ({
  clientId,
  saleIds,
  latitude: -34.61,
  longitude: -58.41
})

const completeMatrix = (ids: string[]): RouteMatrixSegment[] => ids.flatMap((fromId, fromIndex) => ids
  .filter((toId) => toId !== fromId)
  .map((toId, toIndex) => ({
    fromId,
    toId,
    distanceMeters: (fromIndex + 1) * 1000 + toIndex,
    durationSeconds: (fromIndex + 1) * 100 + toIndex
  })))

const input = (stops: RouteStop[], matrix = completeMatrix(['depot', ...stops.map((entry) => entry.clientId)])): RouteHeuristicInput => ({
  depot,
  stops,
  matrix
})

describe('Route heuristic', () => {
  it('S-02: builds a closed route for one grouped stop', () => {
    const result = buildClosedRoute(input([stop('client-1', ['sale-1', 'sale-2'])]))

    expect(result.orderedStops.map((entry) => entry.clientId)).to.deep.equal(['client-1'])
    expect(result.orderedStops[0].saleIds).to.deep.equal(['sale-1', 'sale-2'])
    expect(result.segments.map((segment) => [segment.fromId, segment.toId])).to.deep.equal([
      ['depot', 'client-1'],
      ['client-1', 'depot']
    ])
  })

  it('S-02: covers five and fifteen stops exactly once in a closed route', () => {
    for (const count of [5, 15]) {
      const stops = Array.from({ length: count }, (_, index) => stop(`client-${String(index + 1).padStart(2, '0')}`))
      const result = buildClosedRoute(input(stops))

      expect(result.orderedStops.map((entry) => entry.clientId).sort()).to.deep.equal(stops.map((entry) => entry.clientId).sort())
      expect(result.segments).to.have.length(count + 1)
      expect(result.segments[0].fromId).to.equal('depot')
      expect(result.segments[result.segments.length - 1].toId).to.equal('depot')
    }
  })

  it('S-13: breaks distance, duration, and client identifier ties deterministically', () => {
    const stops = [stop('client-c'), stop('client-a'), stop('client-b')]
    const matrix = completeMatrix(['depot', ...stops.map((entry) => entry.clientId)]).map((segment) => ({
      ...segment,
      distanceMeters: segment.fromId === 'client-b' && segment.toId === 'client-c' ? 1000 : 100,
      durationSeconds: segment.toId === 'client-b' ? 20 : 10
    }))

    const result = buildClosedRoute(input(stops, matrix))

    expect(result.orderedStops.map((entry) => entry.clientId)).to.deep.equal(['client-a', 'client-c', 'client-b'])
  })

  it('S-20: rejects duplicate client IDs, duplicate sale IDs, invalid values, and incomplete matrix pairs', () => {
    const duplicateClient = input([stop('client-1'), stop('client-1', ['sale-2'])])
    const duplicateSale = input([stop('client-1', ['sale-1']), stop('client-2', ['sale-1'])])
    const invalidValue = completeMatrix(['depot', 'client-1'])
    invalidValue[0].distanceMeters = Number.NaN
    const incomplete = input([stop('client-1'), stop('client-2')], completeMatrix(['depot', 'client-1', 'client-2']).filter((segment) => !(segment.fromId === 'client-1' && segment.toId === 'client-2')))

    for (const invalidInput of [duplicateClient, duplicateSale, input([stop('client-1')], invalidValue), incomplete]) {
      expect(() => validateRouteInput(invalidInput)).to.throw(RouteInvariantError)
    }
    expect(() => buildClosedRoute(incomplete)).to.throw(RouteInvariantError).with.property('code', 'ROUTE_MATRIX_INCOMPLETE')
  })

  it('FR-025: calculates stable fuel liters and rejects invalid fuel inputs', () => {
    expect(calculateFuelLiters(123.456, 7.89)).to.equal(9.7406784)
    for (const [distanceKm, litersPer100Km] of [[-1, 7], [10, -1], [Number.POSITIVE_INFINITY, 7], [10, Number.NaN]]) {
      expect(() => calculateFuelLiters(distanceKm, litersPer100Km)).to.throw(RouteInvariantError)
    }
  })
})
