/**
 * TICKET-004: Cashflow Controller — Unit Tests
 * Change: cash-flow-real-v1
 *
 * Covers spec scenarios from specs/cashflow-api/spec.md and
 * specs/cashflow-config/spec.md (controller-level behaviour only —
 * no HTTP routing, no DB).
 *
 * Strategy: pure-unit — mock CashflowService with sinon stubs.
 * We call the exported handler functions directly with fake req/res objects.
 *
 * TS_NODE_TRANSPILE_ONLY=1 is set by npm test; tsc is the type gate.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { expect } = require('chai')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sinon = require('sinon')

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeRes (): any {
  const res: any = {}
  res.status = sinon.stub().returns(res)
  res.json = sinon.stub().returns(res)
  return res
}

function makeReq (overrides: object = {}): any {
  return { query: {}, body: {}, params: {}, ...overrides }
}

// ── Load module under test (after stubs are set up) ───────────────────────────

// We import the service first so we can stub its methods before the
// controller module caches the reference.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cashflowService = require('../src/services/cashflow').default

// eslint-disable-next-line @typescript-eslint/no-var-requires
let controller: any
// Lazy-load after potential stub setup
function getController (): any {
  if (!controller) {
    controller = require('../src/controllers/cashflow')
  }
  return controller
}

// ─── REQ: Missing date params → 400 ─────────────────────────────────────────

describe('TICKET-004 — getSummary controller', () => {
  afterEach(() => sinon.restore())

  it('returns 400 when startDate is missing', async () => {
    const req = makeReq({ query: { endDate: '2026-03-31' } })
    const res = makeRes()
    await getController().getSummary(req, res)
    expect(res.status.calledWith(400)).to.equal(true)
    expect(res.json.calledOnce).to.equal(true)
  })

  it('returns 400 when endDate is missing', async () => {
    const req = makeReq({ query: { startDate: '2026-03-01' } })
    const res = makeRes()
    await getController().getSummary(req, res)
    expect(res.status.calledWith(400)).to.equal(true)
  })

  it('returns 400 when both dates are missing', async () => {
    const req = makeReq({ query: {} })
    const res = makeRes()
    await getController().getSummary(req, res)
    expect(res.status.calledWith(400)).to.equal(true)
  })

  it('delegates to CashflowService.computeSummary with Date objects and returns 200', async () => {
    const fakeSummary = {
      openingBalance: 0,
      totalInflows: 1000,
      totalOutflows: 200,
      netCashFlow: 800,
      closingBalance: 800
    }
    sinon.stub(cashflowService, 'computeSummary').resolves(fakeSummary)

    const req = makeReq({ query: { startDate: '2026-03-01', endDate: '2026-03-31' } })
    const res = makeRes()
    await getController().getSummary(req, res)

    expect(cashflowService.computeSummary.calledOnce).to.equal(true)
    const [s, e] = cashflowService.computeSummary.firstCall.args
    expect(s).to.be.instanceOf(Date)
    expect(e).to.be.instanceOf(Date)
    expect(res.json.calledWith({ summary: fakeSummary })).to.equal(true)
  })
})

// ─── REQ: Timeline endpoint ──────────────────────────────────────────────────

describe('TICKET-004 — getTimeline controller', () => {
  afterEach(() => sinon.restore())

  it('returns 400 when dates are missing', async () => {
    const req = makeReq({ query: {} })
    const res = makeRes()
    await getController().getTimeline(req, res)
    expect(res.status.calledWith(400)).to.equal(true)
  })

  it('returns ordered movements sorted by date ascending', async () => {
    const fakeMovements = [
      { date: new Date('2026-03-15'), type: 'inflow', amount: 100, source: 'sale', description: 'C1', sourceId: '1' },
      { date: new Date('2026-03-10'), type: 'outflow', amount: 50, source: 'expense', description: 'luz', sourceId: '2' }
    ]
    sinon.stub(cashflowService, 'computeMovements').resolves(fakeMovements)

    const req = makeReq({ query: { startDate: '2026-03-01', endDate: '2026-03-31' } })
    const res = makeRes()
    await getController().getTimeline(req, res)

    expect(cashflowService.computeMovements.calledOnce).to.equal(true)
    // timeline must be sorted ascending by date
    const [{ timeline }] = res.json.firstCall.args
    expect(timeline[0].date.getTime()).to.be.lessThanOrEqual(timeline[1].date.getTime())
  })

  it('returns 200 with empty array for period with no movements', async () => {
    sinon.stub(cashflowService, 'computeMovements').resolves([])

    const req = makeReq({ query: { startDate: '2026-03-01', endDate: '2026-03-31' } })
    const res = makeRes()
    await getController().getTimeline(req, res)

    const [{ timeline }] = res.json.firstCall.args
    expect(timeline).to.deep.equal([])
  })
})

// ─── REQ: Movements endpoint ─────────────────────────────────────────────────

describe('TICKET-004 — getMovements controller', () => {
  afterEach(() => sinon.restore())

  it('returns 400 when dates are missing', async () => {
    const req = makeReq({ query: {} })
    const res = makeRes()
    await getController().getMovements(req, res)
    expect(res.status.calledWith(400)).to.equal(true)
  })

  it('returns flat movements array (same count as timeline)', async () => {
    const fakeMovements = [
      { date: new Date('2026-03-10'), type: 'inflow', amount: 100, source: 'sale', description: 'C1', sourceId: '1' },
      { date: new Date('2026-03-12'), type: 'outflow', amount: 30, source: 'expense', description: 'gas', sourceId: '2' }
    ]
    sinon.stub(cashflowService, 'computeMovements').resolves(fakeMovements)

    const req = makeReq({ query: { startDate: '2026-03-01', endDate: '2026-03-31' } })
    const res = makeRes()
    await getController().getMovements(req, res)

    const [{ movements }] = res.json.firstCall.args
    expect(movements).to.have.length(2)
  })
})

// ─── REQ: Config endpoints ────────────────────────────────────────────────────

describe('TICKET-004 — getConfig controller', () => {
  afterEach(() => sinon.restore())

  it('returns 200 with current config (default openingBalance = 0)', async () => {
    sinon.stub(cashflowService, 'getOrCreateConfig').resolves({ openingBalance: 0 })

    const req = makeReq()
    const res = makeRes()
    await getController().getConfig(req, res)

    expect(cashflowService.getOrCreateConfig.calledOnce).to.equal(true)
    expect(res.json.calledWith({ config: { openingBalance: 0 } })).to.equal(true)
  })
})

describe('TICKET-004 — updateConfig controller', () => {
  afterEach(() => sinon.restore())

  it('returns 400 when openingBalance is missing from body', async () => {
    const req = makeReq({ body: {} })
    const res = makeRes()
    await getController().updateConfig(req, res)
    expect(res.status.calledWith(400)).to.equal(true)
  })

  it('returns 400 when openingBalance is not a number', async () => {
    const req = makeReq({ body: { openingBalance: 'not-a-number' } })
    const res = makeRes()
    await getController().updateConfig(req, res)
    expect(res.status.calledWith(400)).to.equal(true)
  })

  it('delegates to CashflowService.updateConfig and returns updated config', async () => {
    sinon.stub(cashflowService, 'updateConfig').resolves({ openingBalance: 8000 })

    const req = makeReq({ body: { openingBalance: 8000 } })
    const res = makeRes()
    await getController().updateConfig(req, res)

    expect(cashflowService.updateConfig.calledWith(8000)).to.equal(true)
    expect(res.json.calledWith({ config: { openingBalance: 8000 } })).to.equal(true)
  })
})
