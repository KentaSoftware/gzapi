/**
 * STRICT TDD — Phase 1 & 2: BuyStats Interface + Service
 *
 * Phase 1: Types & Interfaces — verify exports and re-exports
 * Phase 2: buyStats Service (TDD) — pure functions + mocked aggregation
 *
 * Pure functions (buildBuyStatsMatch, buildEmptySummary, buildSummary)
 * are tested with the real module — no stubbing needed since they're
 * stateless transformations.
 *
 * Aggregation functions (getBuyStatsOverview, getBuyStatsByUser) stub
 * BuyModel.aggregate via sinon before invocation. The module-level
 * import creates a shared reference to the cached BuyModel, so stubbing
 * it affects the service's calls transparently.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { expect } = require('chai')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sinon = require('sinon')

// ─── Shared Helpers ──────────────────────────────────────────────────────────

/**
 * Creates a minimal ResolvedStatsRequest-like fixture.
 * Keys match the interface shape; caller overrides as needed.
 */
function makeResolvedRequest (overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date('2026-06-07T12:00:00.000Z')
  return {
    period: 'month',
    timezone: 'America/Argentina/Buenos_Aires',
    includeCancelled: false,
    from: new Date('2026-06-01T00:00:00.000Z'),
    to: new Date('2026-06-30T23:59:59.999Z'),
    fromIso: '2026-06-01T00:00:00.000Z',
    toIso: '2026-06-30T23:59:59.999Z',
    generatedAt: now,
    scope: 'by-user',
    ...overrides
  }
}

// ─── Phase 2: Service (TDD) — also validates interface imports through the
//     service module's import chain, which correctly resolves via ts-node's
//     CommonJS compilation (avoids Node ESM detection issue). ──────────────────

describe('Phase 2 — buyStats Service', () => {
  // Load the real service module. This succeeds at import time because the
  // module's top-level code only creates Mongoose model references (no DB
  // connection needed). The aggregation pipeline runs only when called.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const buyStats = require('../src/services/buyStats')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const BuyModel = require('../src/models/buy').default

  // ─── buildBuyStatsMatch ──────────────────────────────────────────────────

  describe('buildBuyStatsMatch', () => {
    it('returns match with createdAt $gte and $lte from input dates', () => {
      const input = makeResolvedRequest()
      const match = buyStats.buildBuyStatsMatch(input)

      expect(match).to.have.property('createdAt')
      expect(match.createdAt).to.have.property('$gte')
      expect(match.createdAt).to.have.property('$lte')
      expect(match.createdAt.$gte).to.deep.equal(input.from)
      expect(match.createdAt.$lte).to.deep.equal(input.to)
    })

    it('includes user filter when userObjectId is present', () => {
      const input = makeResolvedRequest({
        userId: '507f1f77bcf86cd799439011',
        userObjectId: { _bsontype: 'ObjectId', toHexString: (): string => '507f1f77bcf86cd799439011' }
      })
      const match = buyStats.buildBuyStatsMatch(input)

      expect(match).to.have.property('user')
    })

    it('omits user filter when userObjectId is undefined', () => {
      const input = makeResolvedRequest({ userId: undefined, userObjectId: undefined })
      const match = buyStats.buildBuyStatsMatch(input)

      expect(match).to.not.have.property('user')
    })

    it('does NOT include cancellation $expr filter (unlike saleStats)', () => {
      const input = makeResolvedRequest()
      const match = buyStats.buildBuyStatsMatch(input)

      expect(match).to.not.have.property('$expr')
    })

    it('does NOT include estado field in match conditions', () => {
      const input = makeResolvedRequest()
      const match = buyStats.buildBuyStatsMatch(input)

      expect(match).to.not.have.property('estado')
    })
  })

  // ─── buildEmptySummary ───────────────────────────────────────────────────

  describe('buildEmptySummary', () => {
    it('returns zeroed summary with from/to/generatedAt from input', () => {
      const input = makeResolvedRequest()
      const summary = buyStats.buildEmptySummary(input)

      expect(summary.totalSalesCount).to.equal(0)
      expect(summary.totalAmount).to.equal(0)
      expect(summary.activeSellersCount).to.equal(0)
      expect(summary.averageTicket).to.equal(0)
      expect(summary.from).to.equal(input.fromIso)
      expect(summary.to).to.equal(input.toIso)
      expect(summary.generatedAt).to.equal(input.generatedAt.toISOString())
    })
  })

  // ─── buildSummary ────────────────────────────────────────────────────────

  describe('buildSummary', () => {
    it('returns empty summary when row is undefined', () => {
      const input = makeResolvedRequest()
      const summary = buyStats.buildSummary(undefined, input)

      expect(summary.totalSalesCount).to.equal(0)
      expect(summary.totalAmount).to.equal(0)
      expect(summary.activeSellersCount).to.equal(0)
      expect(summary.averageTicket).to.equal(0)
      expect(summary.from).to.equal(input.fromIso)
    })

    it('returns computed summary with averageTicket = totalAmount / totalSalesCount', () => {
      const input = makeResolvedRequest()
      const row = { totalSalesCount: 10, totalAmount: 5000, activeSellersCount: 3 }
      const summary = buyStats.buildSummary(row, input)

      expect(summary.totalSalesCount).to.equal(10)
      expect(summary.totalAmount).to.equal(5000)
      expect(summary.activeSellersCount).to.equal(3)
      expect(summary.averageTicket).to.equal(500)
    })

    it('returns averageTicket = 0 when totalSalesCount is 0', () => {
      const input = makeResolvedRequest()
      const row = { totalSalesCount: 0, totalAmount: 0, activeSellersCount: 0 }
      const summary = buyStats.buildSummary(row, input)

      expect(summary.averageTicket).to.equal(0)
    })

    it('rounds totalAmount to 2 decimal places', () => {
      const input = makeResolvedRequest()
      const row = { totalSalesCount: 1, totalAmount: 100.456, activeSellersCount: 1 }
      const summary = buyStats.buildSummary(row, input)

      expect(summary.totalAmount).to.equal(100.46)
    })
  })

  // ─── getBuyStatsOverview (mocked BuyModel.aggregate) ─────────────────────

  describe('getBuyStatsOverview', () => {
    let aggregateStub: sinon.SinonStub

    beforeEach(() => {
      aggregateStub = sinon.stub(BuyModel, 'aggregate')
    })

    afterEach(() => {
      aggregateStub.restore()
    })

    it('returns summary with counts from aggregation result', async () => {
      aggregateStub.resolves([
        { totalBuysCount: 5, totalAmount: 2500, activeProviderIds: ['prov-a', 'prov-b'] }
      ])

      const input = makeResolvedRequest()
      const result = await buyStats.getBuyStatsOverview(input)

      expect(result.summary.totalSalesCount).to.equal(5)
      expect(result.summary.totalAmount).to.equal(2500)
      expect(result.summary.activeSellersCount).to.equal(2)
      expect(result.summary.averageTicket).to.equal(500)
      expect(aggregateStub.calledOnce).to.equal(true)

      // Verify the pipeline has $match and $group stages
      const pipeline = aggregateStub.firstCall.args[0]
      expect(pipeline).to.be.an('array')
      expect(pipeline[0]).to.have.property('$match')
      expect(pipeline[1]).to.have.property('$group')
    })

    it('returns zeroed summary when aggregation returns empty result set', async () => {
      aggregateStub.resolves([])

      const input = makeResolvedRequest()
      const result = await buyStats.getBuyStatsOverview(input)

      expect(result.summary.totalSalesCount).to.equal(0)
      expect(result.summary.totalAmount).to.equal(0)
      expect(result.summary.averageTicket).to.equal(0)
      expect(result.summary.activeSellersCount).to.equal(0)
    })
  })

  // ─── getBuyStatsByUser (mocked BuyModel.aggregate) ───────────────────────

  describe('getBuyStatsByUser', () => {
    let aggregateStub: sinon.SinonStub

    beforeEach(() => {
      aggregateStub = sinon.stub(BuyModel, 'aggregate')
    })

    afterEach(() => {
      aggregateStub.restore()
    })

    it('returns summary and items array from $facet aggregation', async () => {
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

      const input = makeResolvedRequest()
      const result = await buyStats.getBuyStatsByUser(input)

      expect(result.summary.totalSalesCount).to.equal(5)
      expect(result.summary.totalAmount).to.equal(2500)
      expect(result.summary.averageTicket).to.equal(500)
      expect(result.items).to.have.length(2)
      expect(result.items[0].userId).to.equal('user-1')
      expect(result.items[0].nickname).to.equal('Alice')
      expect(result.items[0].averageTicket).to.equal(500)
      expect(result.items[1].userId).to.equal('user-2')
      expect(result.items[1].averageTicket).to.equal(500)

      const pipeline = aggregateStub.firstCall.args[0]
      expect(pipeline).to.be.an('array')
      expect(pipeline[0]).to.have.property('$match')
      expect(pipeline[1]).to.have.property('$facet')
    })

    it('returns zeroed summary and empty items for no-data result', async () => {
      aggregateStub.resolves([{ items: [], summary: [] }])

      const input = makeResolvedRequest()
      const result = await buyStats.getBuyStatsByUser(input)

      expect(result.summary.totalSalesCount).to.equal(0)
      expect(result.summary.totalAmount).to.equal(0)
      expect(result.items).to.be.an('array').with.length(0)
    })
  })
})
