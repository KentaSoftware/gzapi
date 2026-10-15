import axios from 'axios'
import { expect } from 'chai'
import sinon from 'sinon'

import { computeMatrix, RouteProviderError } from '../../src/services/routeMatrixProvider'

describe('Route provider failure observability boundary', () => {
  afterEach(() => sinon.restore())

  it('S-23: performs no more than two attempts and returns a typed bounded failure', async () => {
    process.env.GOOGLE_MAPS_SERVER_API_KEY = 'test-key'
    const post = sinon.stub(axios, 'post').rejects({ code: 'ECONNABORTED' })
    const locations = [
      { id: 'depot', name: 'Depot', latitude: -34.6, longitude: -58.4 },
      { id: 'client', name: 'Client', latitude: -34.61, longitude: -58.41 }
    ]

    try {
      await computeMatrix({ origins: locations, destinations: locations })
      expect.fail('Expected provider failure')
    } catch (error) {
      expect(error).to.be.instanceOf(RouteProviderError)
      expect((error as RouteProviderError).code).to.equal('ROUTING_PROVIDER_UNAVAILABLE')
      expect(post.callCount).to.equal(2)
      expect(JSON.stringify(error)).to.not.match(/address|payload|secret|token/i)
    }
    delete process.env.GOOGLE_MAPS_SERVER_API_KEY
  })
})
