import { expect } from 'chai'
import { buildClosedRoute, validateClientOrder } from '../../src/services/routeHeuristic'

describe('manual client stop order', () => {
  const depot = { id: 'depot', name: 'Depot', latitude: 0, longitude: 0 }
  const stops = [
    { clientId: 'a', saleIds: ['sale-1', 'sale-2'], latitude: 1, longitude: 1 },
    { clientId: 'b', saleIds: ['sale-3'], latitude: 2, longitude: 2 }
  ]
  const matrix = ['depot', 'a', 'b'].flatMap((fromId) => ['depot', 'a', 'b'].filter((toId) => toId !== fromId).map((toId, index) => ({ fromId, toId, distanceMeters: index + 10, durationSeconds: index + 20 })))

  it('uses exactly the requested grouped client order and sourced closed-circuit segments', () => {
    const result = buildClosedRoute({ depot, stops, matrix, clientOrder: ['b', 'a'] })
    expect(result.orderedStops.map((stop) => stop.clientId)).to.deep.equal(['b', 'a'])
    expect(result.orderedStops[1].saleIds).to.deep.equal(['sale-1', 'sale-2'])
    expect(result.segments.map((segment) => [segment.fromId, segment.toId])).to.deep.equal([['depot', 'b'], ['b', 'a'], ['a', 'depot']])
    expect(result.segments[0]).to.deep.equal(matrix.find((segment) => segment.fromId === 'depot' && segment.toId === 'b'))
  })

  it('rejects missing, duplicate, unknown and sale identifiers', () => {
    for (const order of [[], ['a'], ['a', 'a'], ['a', 'c'], ['sale-1', 'b']]) {
      expect(() => validateClientOrder(stops, order)).to.throw()
    }
  })
})
