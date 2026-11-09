import axios from 'axios'
import { expect } from 'chai'
import sinon from 'sinon'
import { computeMatrix, RouteProviderError } from '../../src/services/routeMatrixProvider'

const locations = [
  { id: 'depot', name: 'Depot', latitude: -26.85, longitude: -65.7 },
  { id: 'client-1', name: 'Client 1', latitude: -26.85, longitude: -65.7 },
  { id: 'client-2', name: 'Client 2', latitude: -26.847, longitude: -65.697 }
]

const elements = (): Array<Record<string, unknown>> => [
  { originIndex: 0, destinationIndex: 1, condition: 'ROUTE_EXISTS', status: {}, duration: '0s' },
  { originIndex: 1, destinationIndex: 0, condition: 'ROUTE_EXISTS', status: { code: 0 }, duration: '0s' },
  { originIndex: 0, destinationIndex: 2, condition: 'ROUTE_EXISTS', distanceMeters: 100, duration: '10s' },
  { originIndex: 2, destinationIndex: 0, condition: 'ROUTE_EXISTS', distanceMeters: 110, duration: '11s' },
  { originIndex: 1, destinationIndex: 2, condition: 'ROUTE_EXISTS', distanceMeters: 120, duration: '12s' },
  { originIndex: 2, destinationIndex: 1, condition: 'ROUTE_EXISTS', distanceMeters: 130, duration: '13s' }
]

describe('co-located Google matrix elements', () => {
  let post: sinon.SinonStub
  let originalKey: string | undefined

  beforeEach(() => {
    originalKey = process.env.GOOGLE_MAPS_SERVER_API_KEY
    process.env.GOOGLE_MAPS_SERVER_API_KEY = 'synthetic-test-key'
    post = sinon.stub(axios, 'post')
  })

  afterEach(() => {
    post.restore()
    if (originalKey === undefined) delete process.env.GOOGLE_MAPS_SERVER_API_KEY
    else process.env.GOOGLE_MAPS_SERVER_API_KEY = originalKey
  })

  const run = async (data: Array<Record<string, unknown>>): Promise<Awaited<ReturnType<typeof computeMatrix>>> => {
    post.resolves({ data })
    return await computeMatrix({ origins: locations, destinations: locations })
  }

  const reject = async (data: Array<Record<string, unknown>>): Promise<void> => {
    try {
      await run(data)
      expect.fail('Expected incomplete matrix')
    } catch (error) {
      expect(error).to.be.instanceOf(RouteProviderError)
      expect((error as RouteProviderError).code).to.equal('ROUTE_MATRIX_INCOMPLETE')
    }
  }

  it('normalizes omitted zero distances and preserves all six directed edges', async () => {
    const result = await run(elements())
    expect(result.segments).to.deep.equal([
      { fromId: 'depot', toId: 'client-1', distanceMeters: 0, durationSeconds: 0 },
      { fromId: 'client-1', toId: 'depot', distanceMeters: 0, durationSeconds: 0 },
      { fromId: 'depot', toId: 'client-2', distanceMeters: 100, durationSeconds: 10 },
      { fromId: 'client-2', toId: 'depot', distanceMeters: 110, durationSeconds: 11 },
      { fromId: 'client-1', toId: 'client-2', distanceMeters: 120, durationSeconds: 12 },
      { fromId: 'client-2', toId: 'client-1', distanceMeters: 130, durationSeconds: 13 }
    ])
  })

  it('accepts explicit zero and omitted duration for co-located valid routes', async () => {
    const data = elements()
    data[0].distanceMeters = 0
    delete data[0].duration
    const result = await run(data)
    expect(result.segments[0].distanceMeters).to.equal(0)
    expect(result.segments[0].durationSeconds).to.equal(0)
  })

  it('rejects missing distance for different coordinates', async () => {
    const data = elements()
    delete data[2].distanceMeters
    await reject(data)
  })

  it('rejects missing metrics on unavailable routes or error status', async () => {
    for (const change of [{ condition: 'ROUTE_NOT_FOUND' }, { status: { code: 5 } }, { status: 'invalid' }]) {
      const data = elements()
      Object.assign(data[0], change)
      await reject(data)
    }
  })

  for (const index of [0, 2]) {
    it(`rejects an error status with explicit metrics for pair ${index}`, async () => {
      const data = elements()
      data[0].distanceMeters = 0
      data[1].distanceMeters = 0
      data[index].status = { code: 5 }
      await reject(data)
    })
  }

  it('rejects invalid indices, distance types and coverage holes', async () => {
    for (const value of [-1, Infinity, NaN, null, false, 'invalid']) {
      const data = elements()
      data[0].distanceMeters = value
      await reject(data)
    }
    const badIndex = elements()
    badIndex[0].destinationIndex = 9
    await reject(badIndex)
    await reject(elements().slice(1))
  })

  it('rejects invalid durations and missing duration for different coordinates', async () => {
    for (const value of [-1, null, 'invalid']) {
      const data = elements()
      data[0].duration = value
      await reject(data)
    }
    const data = elements()
    delete data[2].duration
    await reject(data)
  })
})
