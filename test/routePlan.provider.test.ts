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

  it('S-22/TC-011: fails closed without configuration and makes no HTTP request', async () => {
    delete process.env.GOOGLE_MAPS_SERVER_API_KEY

    await expectProviderFailure(async () => await computeMatrix({ origins: locations, destinations: locations }), 'ROUTING_PROVIDER_UNAVAILABLE')

    expect(post.called).to.equal(false)
  })

  it('S-23/TC-011: retries one timeout and returns normalized matrix segments', async () => {
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

  it('S-22/TC-015: classifies 4xx request rejection and quota exhaustion without retrying', async () => {
    post.rejects({ response: { status: 400, data: { error: { status: 'INVALID_ARGUMENT' } } } })

    await expectProviderFailure(async () => await computeMatrix({ origins: locations, destinations: locations }), 'ROUTING_PROVIDER_REQUEST_REJECTED')
    expect(post.callCount).to.equal(1)

    post.resetHistory()
    post.resetBehavior()
    post.rejects({ response: { status: 429, data: { error: { status: 'RESOURCE_EXHAUSTED' } } } })

    await expectProviderFailure(async () => await computeMatrix({ origins: locations, destinations: locations }), 'ROUTING_PROVIDER_QUOTA_EXCEEDED')
    expect(post.callCount).to.equal(1)
  })

  it('S-20/TC-014: rejects a malformed matrix response instead of returning a partial matrix', async () => {
    post.resolves({ data: [matrixResponse[0]] })

    await expectProviderFailure(async () => await computeMatrix({ origins: locations, destinations: locations }), 'ROUTE_MATRIX_INCOMPLETE')
  })

  it('S-20/TC-014: reports a bounded diagnostic identifying incomplete coverage', async () => {
    post.resolves({ data: [matrixResponse[0]] })

    try {
      await computeMatrix({ origins: locations, destinations: locations })
      expect.fail('Expected provider request to fail')
    } catch (error) {
      expect(error).to.be.instanceOf(RouteProviderError)
      const providerError = error as RouteProviderError
      expect(providerError.code).to.equal('ROUTE_MATRIX_INCOMPLETE')
      expect(providerError.diagnostic).to.deep.equal({
        reason: 'INCOMPLETE_COVERAGE',
        expectedElements: 2,
        receivedElements: 1,
        validRoutes: 1,
        conditionCounts: { ROUTE_EXISTS: 1 },
        statusCodeCounts: { MISSING: 1 }
      })
    }
  })

  it('S-20/TC-014: counts conditions and status codes with safe unknown labels', async () => {
    post.resolves({
      data: [
        { originIndex: 0, destinationIndex: 1, condition: 'ROUTE_EXISTS', distanceMeters: 1200, duration: '120s', status: { code: 0 } },
        { originIndex: 1, destinationIndex: 0, condition: 'ROUTE_NOT_FOUND', status: { code: 5 } },
        { originIndex: 0, destinationIndex: 1, condition: undefined, status: {} },
        { originIndex: 1, destinationIndex: 0, status: 42 }
      ]
    })

    try {
      await computeMatrix({ origins: locations, destinations: locations })
      expect.fail('Expected provider request to fail')
    } catch (error) {
      const diagnostic = (error as RouteProviderError).diagnostic
      expect(diagnostic?.reason).to.equal('INCOMPLETE_COVERAGE')
      expect(diagnostic?.receivedElements).to.equal(4)
      expect(diagnostic?.validRoutes).to.equal(1)
      expect(diagnostic?.conditionCounts).to.deep.equal({ MISSING: 2, ROUTE_EXISTS: 1, ROUTE_NOT_FOUND: 1 })
      expect(diagnostic?.statusCodeCounts).to.deep.equal({ 0: 1, 5: 1, UNKNOWN: 2 })
    }
  })

  it('S-22/TC-021: the diagnostic excludes provider payload values and sensitive fields', async () => {
    post.resolves({
      data: [
        {
          originIndex: 0,
          destinationIndex: 1,
          condition: 'ROUTE_NOT_FOUND',
          status: { code: 5, message: 'raw provider detail' },
          address: 'Sensitive customer address',
          latitude: -34.61,
          longitude: -58.41,
          apiKey: 'super-secret-key',
          rawPayload: { nested: 'raw provider payload' }
        }
      ]
    })

    try {
      await computeMatrix({ origins: locations, destinations: locations })
      expect.fail('Expected provider request to fail')
    } catch (error) {
      const text = JSON.stringify((error as RouteProviderError).diagnostic)
      expect(text).to.not.contain('Sensitive customer address')
      expect(text).to.not.contain('-34.61')
      expect(text).to.not.contain('-58.41')
      expect(text).to.not.contain('super-secret-key')
      expect(text).to.not.contain('raw provider payload')
      expect(text).to.not.contain('raw provider detail')
    }
  })

  it('S-20/TC-014: reports a bounded shape diagnostic when the provider returns a non-array payload', async () => {
    post.resolves({ data: { error: { status: 'INVALID_ARGUMENT', message: 'raw provider message' }, routes: [] } })

    try {
      await computeMatrix({ origins: locations, destinations: locations })
      expect.fail('Expected provider request to fail')
    } catch (error) {
      const diagnostic = (error as RouteProviderError).diagnostic
      expect(diagnostic).to.deep.equal({
        reason: 'INVALID_SHAPE',
        expectedElements: 2,
        receivedElements: 0,
        validRoutes: 0,
        conditionCounts: {},
        statusCodeCounts: {},
        responseShape: 'OBJECT(error,routes)'
      })
      expect(JSON.stringify(diagnostic)).to.not.contain('INVALID_ARGUMENT')
      expect(JSON.stringify(diagnostic)).to.not.contain('raw provider message')
    }
  })

  it('S-20/TC-015: normalizes final-route geometry and metrics and rejects malformed responses', async () => {
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
