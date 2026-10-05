import { expect } from 'chai'
import sinon from 'sinon'

import * as routePlanService from '../src/services/routePlan'
import { previewRoute } from '../src/controllers/routePlan'

describe('Route plan observability', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('propagates the request correlation ID to preview domain work', async () => {
    const preview = sinon.stub(routePlanService, 'preview')
    const res: { locals: { correlationId: string }, send: sinon.SinonStub } = {
      locals: { correlationId: 'route-correlation-42' },
      send: sinon.stub()
    }
    const req = {
      body: {
        serviceDate: '2026-10-05',
        deliveryZoneId: '507f1f77bcf86cd799439011',
        saleIds: ['507f1f77bcf86cd799439012']
      }
    }

    await previewRoute(req as never, res as never)

    expect(preview.calledOnce).to.equal(true)
    expect(preview.firstCall.args[1]).to.deep.equal({ correlationId: 'route-correlation-42' })
  })

  it('writes structured route events with safe fields only', () => {
    const log = sinon.stub(console, 'log')

    routePlanService.logRoutePlanEvent({
      event: 'route_plan_provider_completed',
      correlationId: 'route-correlation-42',
      latencyMs: 12,
      provider: 'google-routes',
      algorithmVersion: 'nearest-neighbor-2opt-v1',
      ruleVersion: 'candidate-eligibility-v1',
      routingConfigRevision: 3,
      resultCode: 'SUCCESS'
    })

    expect(log.calledOnce).to.equal(true)
    const event = JSON.parse(log.firstCall.args[0] as string)
    expect(event).to.deep.equal({
      event: 'route_plan_provider_completed',
      correlationId: 'route-correlation-42',
      latencyMs: 12,
      provider: 'google-routes',
      algorithmVersion: 'nearest-neighbor-2opt-v1',
      ruleVersion: 'candidate-eligibility-v1',
      routingConfigRevision: 3,
      resultCode: 'SUCCESS'
    })
    expect(log.firstCall.args[0]).not.to.match(/address|latitude|longitude|token|secret|raw/i)
  })
})
