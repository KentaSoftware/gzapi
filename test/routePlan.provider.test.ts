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
        statusCodeCounts: { MISSING: 1 },
        distanceValueCounts: { NUMBER: 1 }
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
      expect(diagnostic?.distanceValueCounts).to.deep.equal({ MISSING: 3, NUMBER: 1 })
    }
  })

  it('S-20/TC-014: requests element status so rejections can be attributed', async () => {
    post.resolves({ data: matrixResponse })

    await computeMatrix({ origins: locations, destinations: locations })

    const headers = post.firstCall.args[2].headers as Record<string, string>
    const fieldMask = headers['X-Goog-FieldMask']
    for (const field of ['originIndex', 'destinationIndex', 'condition', 'status', 'distanceMeters', 'duration']) {
      expect(fieldMask).to.contain(field)
    }
  })

  it('S-20/TC-014: normalizes numeric-string distanceMeters from protobuf JSON', async () => {
    post.resolves({
      data: [
        { originIndex: 0, destinationIndex: 1, condition: 'ROUTE_EXISTS', distanceMeters: '1200', duration: '120s' },
        { originIndex: 1, destinationIndex: 0, condition: 'ROUTE_EXISTS', distanceMeters: '1300.5', duration: '130s' }
      ]
    })

    const matrix = await computeMatrix({ origins: locations, destinations: locations })

    expect(matrix.segments).to.deep.equal([
      { fromId: 'depot', toId: 'client-1', distanceMeters: 1200, durationSeconds: 120 },
      { fromId: 'client-1', toId: 'depot', distanceMeters: 1300.5, durationSeconds: 130 }
    ])
  })

  it('S-20/TC-014: still rejects malformed, negative, and non-numeric distance values', async () => {
    const threeLocations = [
      { id: 'depot', name: 'Depot', latitude: -34.6, longitude: -58.4 },
      { id: 'client-1', name: 'Client 1', latitude: -34.61, longitude: -58.41 },
      { id: 'client-2', name: 'Client 2', latitude: -34.62, longitude: -58.42 }
    ]
    post.resolves({
      data: [
        { originIndex: 0, destinationIndex: 1, condition: 'ROUTE_EXISTS', distanceMeters: '1200', duration: '120s' },
        { originIndex: 1, destinationIndex: 0, condition: 'ROUTE_EXISTS', distanceMeters: -1200, duration: '120s' },
        { originIndex: 0, destinationIndex: 2, condition: 'ROUTE_EXISTS', distanceMeters: '1200m', duration: '120s' },
        { originIndex: 2, destinationIndex: 0, condition: 'ROUTE_EXISTS', distanceMeters: '1e3', duration: '120s' },
        { originIndex: 1, destinationIndex: 2, condition: 'ROUTE_EXISTS', distanceMeters: null, duration: '120s' },
        { originIndex: 2, destinationIndex: 1, condition: 'ROUTE_EXISTS', distanceMeters: 1700, duration: '120s' }
      ]
    })

    try {
      await computeMatrix({ origins: threeLocations, destinations: threeLocations })
      expect.fail('Expected provider request to fail')
    } catch (error) {
      expect(error).to.be.instanceOf(RouteProviderError)
      const providerError = error as RouteProviderError
      expect(providerError.code).to.equal('ROUTE_MATRIX_INCOMPLETE')
      expect(providerError.diagnostic?.validRoutes).to.equal(2)
      expect(providerError.diagnostic?.rejectionCounts).to.deep.equal({ INVALID_DISTANCE: 4 })
      expect(providerError.diagnostic?.distanceValueCounts).to.deep.equal({ INVALID: 4, NUMBER: 1, NUMERIC_STRING: 1 })
      const text = JSON.stringify(providerError.diagnostic)
      expect(text).to.not.contain('1200m')
      expect(text).to.not.contain('1e3')
    }
  })

  it('S-20/TC-015: normalizes numeric-string final-route distance', async () => {
    post.resolves({
      data: {
        routes: [{ distanceMeters: '2500', duration: '250s', polyline: { encodedPolyline: 'encoded-polyline' } }]
      }
    })

    const route = await computeRoute({
      origin: locations[0],
      intermediates: [locations[1]],
      destination: locations[0]
    })

    expect(route).to.deep.equal({ encodedPolyline: 'encoded-polyline', distanceMeters: 2500, durationSeconds: 250 })
  })

  it('S-20/TC-014: attributes the rejected non-self elements with whitelisted, non-sensitive buckets', async () => {
    const threeLocations = [
      { id: 'depot', name: 'Depot', latitude: -34.6, longitude: -58.4 },
      { id: 'client-1', name: 'Client 1', latitude: -34.61, longitude: -58.41 },
      { id: 'client-2', name: 'Client 2', latitude: -34.62, longitude: -58.42 }
    ]
    post.resolves({
      data: [
        { originIndex: 0, destinationIndex: 0, condition: 'ROUTE_EXISTS', distanceMeters: 0, duration: '0s' },
        { originIndex: 1, destinationIndex: 1, condition: 'ROUTE_EXISTS', distanceMeters: 0, duration: '0s' },
        { originIndex: 2, destinationIndex: 2, condition: 'ROUTE_EXISTS', distanceMeters: 0, duration: '0s' },
        { originIndex: 0, destinationIndex: 1, condition: 'ROUTE_EXISTS', distanceMeters: 1200, duration: '120s', status: { code: 0 } },
        { originIndex: 1, destinationIndex: 0, condition: 'ROUTE_EXISTS', distanceMeters: 1300, duration: '130s', status: { code: 0 } },
        { originIndex: 0, destinationIndex: 2, condition: 'ROUTE_EXISTS', distanceMeters: 1400, duration: '140s', status: { code: 0 } },
        { originIndex: 2, destinationIndex: 0, condition: 'ROUTE_EXISTS', distanceMeters: 1500, duration: '150s', status: { code: 0 } },
        { originIndex: 1, destinationIndex: 2, condition: 'ROUTE_EXISTS', distanceMeters: 'raw-provider-distance', duration: '160s', address: 'Sensitive customer address', apiKey: 'super-secret-key' },
        { originIndex: 2, destinationIndex: 1, condition: 'ROUTE_EXISTS', distanceMeters: 1700, duration: 'not-a-duration', latitude: -34.61, longitude: -58.41 }
      ]
    })

    try {
      await computeMatrix({ origins: threeLocations, destinations: threeLocations })
      expect.fail('Expected provider request to fail')
    } catch (error) {
      expect(error).to.be.instanceOf(RouteProviderError)
      const providerError = error as RouteProviderError
      expect(providerError.code).to.equal('ROUTE_MATRIX_INCOMPLETE')
      expect(providerError.diagnostic?.expectedElements).to.equal(6)
      expect(providerError.diagnostic?.receivedElements).to.equal(9)
      expect(providerError.diagnostic?.validRoutes).to.equal(4)
      expect(providerError.diagnostic?.rejectionCounts).to.deep.equal({ INVALID_DURATION: 1, INVALID_DISTANCE: 1, SELF_PAIR: 3 })
      const text = JSON.stringify(providerError.diagnostic)
      expect(text).to.not.contain('Sensitive customer address')
      expect(text).to.not.contain('-34.61')
      expect(text).to.not.contain('-58.41')
      expect(text).to.not.contain('super-secret-key')
      expect(text).to.not.contain('raw-provider-distance')
      expect(text).to.not.contain('not-a-duration')
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

  it('S-20/TC-014: reports non-self rejected pairs with whitelisted reasons in deterministic order', async () => {
    const threeLocations = [
      { id: 'depot', name: 'Depot', latitude: -34.6, longitude: -58.4 },
      { id: 'client-1', name: 'Client 1', latitude: -34.61, longitude: -58.41 },
      { id: 'client-2', name: 'Client 2', latitude: -34.62, longitude: -58.42 }
    ]
    post.resolves({
      data: [
        { originIndex: 0, destinationIndex: 0, condition: 'ROUTE_EXISTS', distanceMeters: 0, duration: '0s' },
        { originIndex: 1, destinationIndex: 1, condition: 'ROUTE_EXISTS', distanceMeters: 0, duration: '0s' },
        { originIndex: 2, destinationIndex: 2, condition: 'ROUTE_EXISTS', distanceMeters: 0, duration: '0s' },
        { originIndex: 0, destinationIndex: 1, condition: 'ROUTE_EXISTS', distanceMeters: 1200, duration: '120s' },
        { originIndex: 0, destinationIndex: 1, condition: 'ROUTE_EXISTS', distanceMeters: 1250, duration: '125s' },
        { originIndex: 1, destinationIndex: 0, condition: 'ROUTE_EXISTS', distanceMeters: 'invalid', duration: '130s' },
        { originIndex: 0, destinationIndex: 2, condition: 'ROUTE_NOT_FOUND' },
        { originIndex: 2, destinationIndex: 0, condition: 'ROUTE_EXISTS', distanceMeters: 1400, duration: 'not-a-duration' },
        { originIndex: 1, destinationIndex: 2, condition: 'ROUTE_EXISTS', distanceMeters: 1600, duration: '160s' },
        { originIndex: 2, destinationIndex: 1, condition: 'ROUTE_EXISTS', distanceMeters: 1700, duration: '170s' }
      ]
    })

    try {
      await computeMatrix({ origins: threeLocations, destinations: threeLocations })
      expect.fail('Expected provider request to fail')
    } catch (error) {
      expect(error).to.be.instanceOf(RouteProviderError)
      const providerError = error as RouteProviderError
      expect(providerError.code).to.equal('ROUTE_MATRIX_INCOMPLETE')
      expect(providerError.diagnostic?.rejectionCounts).to.deep.equal({
        DUPLICATE_PAIR: 1,
        INVALID_DISTANCE: 1,
        INVALID_DURATION: 1,
        OTHER: 1,
        SELF_PAIR: 3
      })
      expect(providerError.diagnostic?.rejectedPairs).to.deep.equal([
        { originIndex: 0, destinationIndex: 1, reason: 'DUPLICATE_PAIR' },
        { originIndex: 1, destinationIndex: 0, reason: 'INVALID_DISTANCE' },
        { originIndex: 0, destinationIndex: 2, reason: 'OTHER' },
        { originIndex: 2, destinationIndex: 0, reason: 'INVALID_DURATION' }
      ])
      for (const pair of providerError.diagnostic?.rejectedPairs ?? []) {
        expect(pair.originIndex).to.not.equal(pair.destinationIndex)
      }
    }
  })

  it('S-20/TC-014: bounds rejected-pair diagnostics to eight non-self entries', async () => {
    const fourLocations = [
      { id: 'depot', name: 'Depot', latitude: -34.6, longitude: -58.4 },
      { id: 'client-1', name: 'Client 1', latitude: -34.61, longitude: -58.41 },
      { id: 'client-2', name: 'Client 2', latitude: -34.62, longitude: -58.42 },
      { id: 'client-3', name: 'Client 3', latitude: -34.63, longitude: -58.43 }
    ]
    const data: Array<Record<string, unknown>> = []
    for (let originIndex = 0; originIndex < fourLocations.length; originIndex += 1) {
      for (let destinationIndex = 0; destinationIndex < fourLocations.length; destinationIndex += 1) {
        data.push({ originIndex, destinationIndex, condition: 'ROUTE_EXISTS', distanceMeters: 'invalid', duration: '1s' })
      }
    }
    post.resolves({ data })

    try {
      await computeMatrix({ origins: fourLocations, destinations: fourLocations })
      expect.fail('Expected provider request to fail')
    } catch (error) {
      const diagnostic = (error as RouteProviderError).diagnostic
      expect(diagnostic?.rejectionCounts?.SELF_PAIR).to.equal(4)
      expect(diagnostic?.rejectionCounts?.INVALID_DISTANCE).to.equal(12)
      expect(diagnostic?.rejectedPairs).to.have.length(8)
      expect(diagnostic?.rejectedPairs).to.deep.equal([
        { originIndex: 0, destinationIndex: 1, reason: 'INVALID_DISTANCE' },
        { originIndex: 0, destinationIndex: 2, reason: 'INVALID_DISTANCE' },
        { originIndex: 0, destinationIndex: 3, reason: 'INVALID_DISTANCE' },
        { originIndex: 1, destinationIndex: 0, reason: 'INVALID_DISTANCE' },
        { originIndex: 1, destinationIndex: 2, reason: 'INVALID_DISTANCE' },
        { originIndex: 1, destinationIndex: 3, reason: 'INVALID_DISTANCE' },
        { originIndex: 2, destinationIndex: 0, reason: 'INVALID_DISTANCE' },
        { originIndex: 2, destinationIndex: 1, reason: 'INVALID_DISTANCE' }
      ])
    }
  })

  it('S-22/TC-021: rejected-pair diagnostics exclude sensitive fields and raw values', async () => {
    post.resolves({
      data: [
        {
          originIndex: 0,
          destinationIndex: 1,
          condition: 'ROUTE_EXISTS',
          distanceMeters: 'raw-provider-distance',
          duration: 'not-a-duration',
          address: 'Sensitive customer address',
          apiKey: 'super-secret-key',
          latitude: -34.61,
          longitude: -58.41,
          status: { code: 3, message: 'raw provider detail' },
          rawPayload: { nested: 'raw provider payload' }
        }
      ]
    })

    try {
      await computeMatrix({ origins: locations, destinations: locations })
      expect.fail('Expected provider request to fail')
    } catch (error) {
      const diagnostic = (error as RouteProviderError).diagnostic
      expect(diagnostic?.rejectedPairs).to.deep.equal([
        { originIndex: 0, destinationIndex: 1, reason: 'INVALID_DISTANCE' }
      ])
      const text = JSON.stringify(diagnostic)
      expect(text).to.not.contain('Sensitive customer address')
      expect(text).to.not.contain('-34.61')
      expect(text).to.not.contain('-58.41')
      expect(text).to.not.contain('super-secret-key')
      expect(text).to.not.contain('raw-provider-distance')
      expect(text).to.not.contain('not-a-duration')
      expect(text).to.not.contain('raw provider detail')
      expect(text).to.not.contain('raw provider payload')
    }
  })
})
