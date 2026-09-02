/**
 * STRICT TDD — Phase 3: Buy Stats Controller & Routes
 *
 * Integration-style unit tests — calls controller handlers directly with
 * fake req/res objects. Stubs BuyModel.aggregate for service calls to
 * avoid requiring a real DB connection. Validation is tested with real
 * parseSaleStatsRequest to cover the full controller validation path.
 *
 * Strategy: pure-unit — no HTTP routing, no DB.
 * - Validation errors: pass invalid body shapes → expect 400
 * - Success paths: stub BuyModel.aggregate → expect correct response shape
 * - Error path: stub BuyModel.aggregate to reject → expect 500 via handleHttp
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { expect } = require('chai')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sinon = require('sinon')

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeRes (): any {
  const res: any = {}
  res.status = sinon.stub().returns(res)
  res.send = sinon.stub().returns(res)
  return res
}

function makeReq (overrides: object = {}): any {
  return { body: {}, params: {}, query: {}, ...overrides }
}

// ── Load modules before controller (so we can stub Mongoose) ──────────────────

const BuyModel = require('../src/models/buy').default

// Lazy-load controller so the first call captures stubs correctly.
let controller: any

function getController (): any {
  if (!controller) {
    controller = require('../src/controllers/buy')
  }
  return controller
}

// ── Phase 3: Controller Tests ─────────────────────────────────────────────────

describe('Phase 3 — getBuyStatsByUserController', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('returns 400 when period is invalid', async () => {
    const req = makeReq({ body: { period: 'not-a-valid-period' } })
    const res = makeRes()

    await getController().getBuyStatsByUserController(req, res)

    expect(res.status.calledWith(400)).to.equal(true)
    expect(res.send.calledOnce).to.equal(true)
  })

  it('returns 400 when body is not an object', async () => {
    const req = makeReq({ body: 'string-body' })
    const res = makeRes()

    await getController().getBuyStatsByUserController(req, res)

    expect(res.status.calledWith(400)).to.equal(true)
  })

  it('returns 400 when custom period lacks from/to', async () => {
    const req = makeReq({ body: { period: 'custom' } })
    const res = makeRes()

    await getController().getBuyStatsByUserController(req, res)

    expect(res.status.calledWith(400)).to.equal(true)
  })

  it('returns 400 when userId is not a valid ObjectId', async () => {
    const req = makeReq({ body: { period: 'month', userId: 'not-an-objectid' } })
    const res = makeRes()

    await getController().getBuyStatsByUserController(req, res)

    expect(res.status.calledWith(400)).to.equal(true)
  })

  it('returns summary and items on successful call', async () => {
    const aggregateStub = sinon.stub(BuyModel, 'aggregate')
    aggregateStub.resolves([
      {
        items: [
          { _id: 'user-1', nickname: 'Alice', salesCount: 3, totalAmount: 1500 },
          { _id: 'user-2', nickname: 'Bob', salesCount: 2, totalAmount: 1000 }
        ],
        summary: [
          { totalSalesCount: 5, totalAmount: 2500, activeUserIds: ['user-1', 'user-2'] }
        ]
      }
    ])

    const req = makeReq({ body: { period: 'month' } })
    const res = makeRes()

    await getController().getBuyStatsByUserController(req, res)

    expect(res.send.calledOnce).to.equal(true)
    const data = res.send.firstCall.args[0]
    expect(data).to.have.property('summary')
    expect(data).to.have.property('items')
    expect(data.items).to.have.length(2)
    expect(data.summary.totalSalesCount).to.equal(5)
    expect(data.summary.totalAmount).to.equal(2500)
  })

  it('returns empty items when no data exists', async () => {
    const aggregateStub = sinon.stub(BuyModel, 'aggregate')
    aggregateStub.resolves([{ items: [], summary: [] }])

    const req = makeReq({ body: { period: 'week' } })
    const res = makeRes()

    await getController().getBuyStatsByUserController(req, res)

    const data = res.send.firstCall.args[0]
    expect(data.items).to.be.an('array').that.is.empty
    expect(data.summary.totalSalesCount).to.equal(0)
  })

  it('calls handleHttp (500) when service throws', async () => {
    const aggregateStub = sinon.stub(BuyModel, 'aggregate')
    aggregateStub.rejects(new Error('DB connection failed'))

    const req = makeReq({ body: { period: 'month' } })
    const res = makeRes()

    await getController().getBuyStatsByUserController(req, res)

    expect(res.status.calledWith(500)).to.equal(true)
  })
})

describe('Phase 3 — getBuyStatsOverviewController', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('returns 400 when period is invalid', async () => {
    const req = makeReq({ body: { period: null } })
    const res = makeRes()

    await getController().getBuyStatsOverviewController(req, res)

    expect(res.status.calledWith(400)).to.equal(true)
    expect(res.send.calledOnce).to.equal(true)
  })

  it('returns 400 when body is not an object', async () => {
    const req = makeReq({ body: 42 })
    const res = makeRes()

    await getController().getBuyStatsOverviewController(req, res)

    expect(res.status.calledWith(400)).to.equal(true)
  })

  it('returns 400 when userId is provided (not allowed for overview)', async () => {
    const req = makeReq({ body: { period: 'month', userId: '507f1f77bcf86cd799439011' } })
    const res = makeRes()

    await getController().getBuyStatsOverviewController(req, res)

    expect(res.status.calledWith(400)).to.equal(true)
    const data = res.send.firstCall.args[0]
    expect(data).to.have.property('code')
    expect(data.code).to.equal('USER_ID_NOT_ALLOWED')
  })

  it('returns summary on successful call', async () => {
    const aggregateStub = sinon.stub(BuyModel, 'aggregate')
    aggregateStub.resolves([
      { totalBuysCount: 8, totalAmount: 4200, activeProviderIds: ['prov-a', 'prov-b', 'prov-c'] }
    ])

    const req = makeReq({ body: { period: 'year' } })
    const res = makeRes()

    await getController().getBuyStatsOverviewController(req, res)

    expect(res.send.calledOnce).to.equal(true)
    const data = res.send.firstCall.args[0]
    expect(data).to.have.property('summary')
    expect(data.summary.totalSalesCount).to.equal(8)
    expect(data.summary.totalAmount).to.equal(4200)
    expect(data.summary.activeSellersCount).to.equal(3)
  })

  it('returns zeroed summary when no data exists', async () => {
    const aggregateStub = sinon.stub(BuyModel, 'aggregate')
    aggregateStub.resolves([])

    const req = makeReq({ body: { period: 'month' } })
    const res = makeRes()

    await getController().getBuyStatsOverviewController(req, res)

    const data = res.send.firstCall.args[0]
    expect(data.summary.totalSalesCount).to.equal(0)
    expect(data.summary.totalAmount).to.equal(0)
    expect(data.summary.averageTicket).to.equal(0)
  })

  it('calls handleHttp (500) when service throws', async () => {
    const aggregateStub = sinon.stub(BuyModel, 'aggregate')
    aggregateStub.rejects(new Error('Aggregation error'))

    const req = makeReq({ body: { period: 'month' } })
    const res = makeRes()

    await getController().getBuyStatsOverviewController(req, res)

    expect(res.status.calledWith(500)).to.equal(true)
  })
})
