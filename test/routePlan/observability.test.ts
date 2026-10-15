import { expect } from 'chai'
import sinon from 'sinon'

import DeliveryZoneModel from '../../src/models/deliveryZone'
import * as routePlanService from '../../src/services/routePlan'
import * as routePlanOperational from '../../src/services/routePlanOperational'
import { getDashboard } from '../../src/services/routeDashboard'
import { getRouteAssignmentOptions, patchRoutePlanOperational } from '../../src/controllers/routePlan'

describe('Route failure-path observability', () => {
  afterEach(() => sinon.restore())

  it('TC-021: logs bounded dashboard fields with correlation, outcome and latency', async () => {
    const zoneReader = { lean: async () => null }
    sinon.stub(DeliveryZoneModel, 'findOne').returns(zoneReader as never)
    const log = sinon.stub(console, 'log')

    await getDashboard({ serviceDate: '2026-10-05', zoneCode: 'NORTE' }, { correlationId: 'dashboard-correlation', actor: 'operator-1' })

    const eventText: string = log.lastCall.args[0] as string
    const event = JSON.parse(eventText) as Record<string, unknown>
    expect(event).to.include({ operation: 'dashboard.read', outcome: 'ROUTE_ZONE_NOT_FOUND', correlationId: 'dashboard-correlation', actor: 'operator-1' })
    expect(event.latencyMs).to.be.a('number')
    expect(JSON.stringify(event)).to.not.match(/address|payload|secret|token|sales/i)
    const result = await getDashboard({ serviceDate: '2026-10-05', zoneCode: 'NORTE' })
    expect(result.mapLocations).to.deep.equal([])
  })

  it('TC-021: logs assignment-options success without response arrays', async () => {
    sinon.stub(routePlanService, 'getAssignmentOptions').resolves({ drivers: [], vehicles: [] })
    const log = sinon.stub(console, 'log')
    const res = { locals: { correlationId: 'options-correlation', userId: 'operator-2' }, send: sinon.stub() }

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    await getRouteAssignmentOptions({} as never, res as never)

    const eventText: string = log.lastCall.args[0] as string
    const event = JSON.parse(eventText) as Record<string, unknown>
    expect(event).to.include({ operation: 'assignment-options.read', outcome: 'SUCCESS', correlationId: 'options-correlation', actor: 'operator-2' })
    expect(event.latencyMs).to.be.a('number')
    expect(JSON.stringify(event)).to.not.match(/drivers|vehicles|payload|secret|token/i)
  })

  it('TC-024: propagates correlation and logs operational update outcome with opaque snapshot id', async () => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    sinon.stub(routePlanOperational, 'createProjection').resolves({} as never)
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    sinon.stub(routePlanOperational, 'assign').resolves({ version: 2 } as never)
    const log = sinon.stub(console, 'log')
    const res = { locals: { correlationId: 'operation-correlation', userId: 'operator-3' }, send: sinon.stub() }
    const req = { params: { id: '507f1f77bcf86cd799439011' }, body: { version: 1, driverId: 'driver-1', vehicleId: 'vehicle-1' } }

    await patchRoutePlanOperational(req as never, res as never)

    expect(routePlanOperational.assign.calledOnce).to.equal(true)
    expect(routePlanOperational.assign.firstCall.args[1]).to.include({ correlationId: 'operation-correlation', changedBy: 'operator-3' })
    const eventText: string = log.lastCall.args[0] as string
    const event = JSON.parse(eventText) as Record<string, unknown>
    expect(event).to.include({ operation: 'operational.update', outcome: 'SUCCESS', correlationId: 'operation-correlation', actor: 'operator-3', routeSnapshotId: req.params.id })
    expect(event.latencyMs).to.be.a('number')
    expect(JSON.stringify(event)).to.not.match(/address|payload|secret|token|body/i)
  })
})
