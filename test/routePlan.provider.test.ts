import axios from 'axios'
import { expect } from 'chai'
import sinon from 'sinon'
import {
  computeMatrix,
  computeRoute,
  RouteProviderError
} from '../src/services/routeMatrixProvider'

const locations = [
  { id: 'depot', name: 'Depot', latitude: -34.6, longitude: -58.4 },
  { id: 'client-1', name: 'Client 1', latitude: -34.61, longitude: -58.41 }
]

const matrixResponse = [
  { originIndex: 0, destinationIndex: 1, condition: 'ROUTE_EXISTS', distanceMeters: 1200, duration: '120s' },
  { originIndex: 1, destinationIndex: 0, condition: 'ROUTE_EXISTS', distanceMeters: 1300, duration: '130s' }
]

const finalRouteResponse = {
  routes: [{
    distanceMeters: 2500,
    duration: '250s',
    polyline: { encodedPolyline: 'encoded-polyline' }
  }]
}

const expectProviderFailure = async (action: () => Promise<unknown>, code: string): Promise<void> => {
  try {
    await action()
    expect.fail('Expected provider request to fail')
  } catch (error) {
    expect(error).to.be.instanceOf(RouteProviderError)
    expect((error as RouteProviderError).code).to.equal(code)
  }
}

describe('Google Routes provider', () => {
  let post: sinon.SinonStub

  beforeEach(() => {
    process.env.GOOGLE_MAPS_SERVER_API_KEY = 'test-key'
    post = sinon.stub(axios, 'post')
  })

  afterEach(() => {
    sinon.restore()
    delete process.env.GOOGLE_MAPS_SERVER_API_KEY
  })

  it('S-22: fails closed without configuration and makes no HTTP request', async () => {
    delete process.env.GOOGLE_MAPS_SERVER_API_KEY

    await expectProviderFailure(async () => await computeMatrix({ origins: locations, destinations: locations }), 'ROUTING_PROVIDER_UNAVAILABLE')

    expect(post.called).to.equal(false)
  })

  it('S-23: retries one timeout and returns normalized matrix segments', async () => {
    post.onFirstCall().rejects({ code: 'ECONNABORTED' })
    post.onSecondCall().resolves({ data: matrixResponse })

    const matrix = await computeMatrix({ origins: locations, destinations: locations })

    expect(post.callCount).to.equal(2)
    expect(matrix.segments).to.deep.equal([
      { fromId: 'depot', toId: 'client-1', distanceMeters: 1200, durationSeconds: 120 },
      { fromId: 'client-1', toId: 'depot', distanceMeters: 1300, durationSeconds: 130 }
    ])
  })

  it('S-23: fails with a typed unavailable error after a second timeout', async () => {
    post.rejects({ code: 'ECONNABORTED' })

    await expectProviderFailure(async () => await computeMatrix({ origins: locations, destinations: locations }), 'ROUTING_PROVIDER_UNAVAILABLE')

    expect(post.callCount).to.equal(2)
  })

  it('S-22: classifies 4xx request rejection and quota exhaustion without retrying', async () => {
    post.rejects({ response: { status: 400, data: { error: { status: 'INVALID_ARGUMENT' } } } })

    await expectProviderFailure(async () => await computeMatrix({ origins: locations, destinations: locations }), 'ROUTING_PROVIDER_REQUEST_REJECTED')
    expect(post.callCount).to.equal(1)

    post.resetHistory()
    post.resetBehavior()
    post.rejects({ response: { status: 429, data: { error: { status: 'RESOURCE_EXHAUSTED' } } } })

    await expectProviderFailure(async () => await computeMatrix({ origins: locations, destinations: locations }), 'ROUTING_PROVIDER_QUOTA_EXCEEDED')
    expect(post.callCount).to.equal(1)
  })

  it('S-20: rejects a malformed matrix response instead of returning a partial matrix', async () => {
    post.resolves({ data: [matrixResponse[0]] })

    await expectProviderFailure(async () => await computeMatrix({ origins: locations, destinations: locations }), 'ROUTE_MATRIX_INCOMPLETE')
  })

  it('S-20: normalizes final-route geometry and metrics and rejects malformed responses', async () => {
    post.resolves({ data: finalRouteResponse })

    const route = await computeRoute({
      origin: locations[0],
      intermediates: [locations[1]],
      destination: locations[0]
    })

    expect(route).to.deep.equal({ encodedPolyline: 'encoded-polyline', distanceMeters: 2500, durationSeconds: 250 })

    post.resetBehavior()
    post.resolves({ data: { routes: [{}] } })

    await expectProviderFailure(async () => await computeRoute({ origin: locations[0], intermediates: [locations[1]], destination: locations[0] }), 'ROUTE_FINAL_ROUTE_INVALID')
  })
})
