/**
 * STRICT TDD — Phase 4: Dataset Trends for Buys
 *
 * Tests that ALL 5 dataset period functions return buy items with
 * totalSalesDifference and salesCountDifference fields.
 *
 * Strategy: stub BuyModel.aggregate + SaleModel.aggregate for each
 * period function. This follows the same pattern as buyStats.test.ts
 * (mocked aggregation, sinon stubs restored after each test).
 *
 * getDailyData serves as the primary test target (all 5 functions
 * follow the identical pattern). One additional triangulation test
 * covers getWeeklyData to prove the pattern generalizes.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { expect } = require('chai')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sinon = require('sinon')

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Converts percentage values to a comparable number to avoid string/type
 * brittleness. The dataset service may return 0 (number) or "0" (string)
 * depending on the branch, so we test the numeric value.
 */
function asNumber (val: unknown): number {
  if (typeof val === 'string') return parseFloat(val)
  if (typeof val === 'number') return val
  return NaN
}

// ─── Phase 4: Dataset Trends for Buys ─────────────────────────────────────────

describe('Phase 4 — Dataset Trends for Buys', () => {
  // Load the real dataset service module
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dataset = require('../src/services/dataset')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const BuyModel = require('../src/models/buy').default
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const SaleModel = require('../src/models/sale').default

  // ─── getDailyData ───────────────────────────────────────────────────────

  describe('getDailyData', () => {
    let buyStub: sinon.SinonStub
    let saleStub: sinon.SinonStub

    beforeEach(() => {
      buyStub = sinon.stub(BuyModel, 'aggregate')
      saleStub = sinon.stub(SaleModel, 'aggregate')
    })

    afterEach(() => {
      buyStub.restore()
      saleStub.restore()
    })

    it('returns buy item with positively computed differences when both periods have data', async () => {
      // Sale stubs (must return something or the function may crash)
      saleStub.onFirstCall().resolves([{ totalSales: 2000, salesCount: 10 }])
      saleStub.onSecondCall().resolves([{ totalSales: 1500, salesCount: 8 }])
      // Buy stubs — current > previous → positive differences
      buyStub.onFirstCall().resolves([{ totalSales: 1000, salesCount: 5 }])
      buyStub.onSecondCall().resolves([{ totalSales: 800, salesCount: 4 }])

      const result = await dataset.getDailyData()
      // result[1] is the buy item (result[0] is sale)
      const buyItem = result[1]

      expect(buyItem).to.have.property('label', 'buy')
      expect(buyItem).to.have.property('totalSalesDifference')
      expect(buyItem).to.have.property('salesCountDifference')
      // (1000-800)/800 * 100 = 25.00
      expect(asNumber(buyItem.totalSalesDifference)).to.equal(25)
      // (5-4)/4 * 100 = 25.00
      expect(asNumber(buyItem.salesCountDifference)).to.equal(25)
    })

    it('returns 0 for differences when previous period has no data (division-by-zero guard)', async () => {
      saleStub.onFirstCall().resolves([{ totalSales: 2000, salesCount: 10 }])
      saleStub.onSecondCall().resolves([{ totalSales: 1500, salesCount: 8 }])
      buyStub.onFirstCall().resolves([{ totalSales: 1000, salesCount: 5 }])
      // No previous buy data
      buyStub.onSecondCall().resolves([])

      const result = await dataset.getDailyData()
      const buyItem = result[1]

      expect(asNumber(buyItem.totalSalesDifference)).to.equal(0)
      expect(asNumber(buyItem.salesCountDifference)).to.equal(0)
    })

    it('returns 0 for differences when there is no current buy data but previous exists', async () => {
      saleStub.onFirstCall().resolves([{ totalSales: 2000, salesCount: 10 }])
      saleStub.onSecondCall().resolves([{ totalSales: 1500, salesCount: 8 }])
      // No current buy data
      buyStub.onFirstCall().resolves([])
      buyStub.onSecondCall().resolves([{ totalSales: 800, salesCount: 4 }])

      const result = await dataset.getDailyData()
      const buyItem = result[1]

      expect(buyItem.totalSales).to.equal(0)
      expect(buyItem.salesCount).to.equal(0)
      expect(asNumber(buyItem.totalSalesDifference)).to.equal(0)
      expect(asNumber(buyItem.salesCountDifference)).to.equal(0)
    })

    it('returns 0 for differences when both current and previous periods have no data', async () => {
      saleStub.onFirstCall().resolves([{ totalSales: 2000, salesCount: 10 }])
      saleStub.onSecondCall().resolves([{ totalSales: 1500, salesCount: 8 }])
      buyStub.onFirstCall().resolves([])
      buyStub.onSecondCall().resolves([])

      const result = await dataset.getDailyData()
      const buyItem = result[1]

      expect(buyItem.totalSales).to.equal(0)
      expect(buyItem.salesCount).to.equal(0)
      expect(asNumber(buyItem.totalSalesDifference)).to.equal(0)
      expect(asNumber(buyItem.salesCountDifference)).to.equal(0)
    })

    it('does not alter the sale item structure or values', async () => {
      saleStub.onFirstCall().resolves([{ totalSales: 2000, salesCount: 10 }])
      saleStub.onSecondCall().resolves([{ totalSales: 1500, salesCount: 8 }])
      buyStub.onFirstCall().resolves([{ totalSales: 1000, salesCount: 5 }])
      buyStub.onSecondCall().resolves([{ totalSales: 800, salesCount: 4 }])

      const result = await dataset.getDailyData()
      const saleItem = result[0]

      expect(saleItem).to.have.property('label', 'sale')
      expect(saleItem).to.have.property('totalSalesDifference')
      expect(saleItem).to.have.property('salesCountDifference')
      // (2000-1500)/1500 * 100 = 33.33
      expect(asNumber(saleItem.totalSalesDifference)).to.be.closeTo(33.33, 0.01)
      // (10-8)/8 * 100 = 25.00
      expect(asNumber(saleItem.salesCountDifference)).to.equal(25)
    })
  })

  // ─── P1: getWeeklyData week boundaries (align with getWeeklyDataGraph) ─────

  describe('getWeeklyData — P1 week boundary alignment', () => {
    let buyStub: sinon.SinonStub
    let saleStub: sinon.SinonStub
    let clock: sinon.SinonFakeTimers

    beforeEach(() => {
      buyStub = sinon.stub(BuyModel, 'aggregate')
      saleStub = sinon.stub(SaleModel, 'aggregate')
      // Freeze time to Wednesday June 10, 2026 — a mid-week anchor
      clock = sinon.useFakeTimers(new Date('2026-06-10T12:00:00-03:00'))
    })

    afterEach(() => {
      buyStub.restore()
      saleStub.restore()
      clock.restore()
    })

    it('returns the same Monday-Sunday week interval as getWeeklyDataGraph', async () => {
      // Both aggregations must return data for the stubs to pass through
      saleStub.resolves([{ totalSales: 1000, salesCount: 5 }])
      buyStub.resolves([{ totalSales: 500, salesCount: 3 }])

      const simple = await dataset.getWeeklyData()
      const graph = await dataset.getWeeklyDataGraph()

      // simple[0].date is the interval from getWeeklyData (e.g. "08-06 a 15-06")
      // graph.data[0].label is the interval from getWeeklyDataGraph
      // With the fix, both use weekStartsOn: 1 and +3h → same Monday-Sunday period
      expect(simple[0]).to.have.property('date')
      expect(graph.data[0]).to.have.property('label')
      expect(simple[0].date).to.equal(graph.data[0].label)
    })

    it('uses Monday as start of week (not Sunday)', async () => {
      saleStub.resolves([{ totalSales: 1000, salesCount: 5 }])
      buyStub.resolves([{ totalSales: 500, salesCount: 3 }])

      const simple = await dataset.getWeeklyData()

      // Frozen to Wednesday June 10 → Monday June 8 03:00, end = June 15 02:59:59
      // interval = "08-06 a 15-06" (Monday start, not Sunday)
      expect(simple[0].date).to.match(/^\d{2}-\d{2} a \d{2}-\d{2}$/)
      // First day should be 08 (Monday June 8), not 07 (Sunday June 7)
      const dayStart = simple[0].date.split(' a ')[0].split('-')[0]
      expect(dayStart).to.equal('08')
    })
  })

  // ─── P6: getAnnuallyDataGraph excludes canceled sales ──────────────────

  describe('getAnnuallyDataGraph — P6 exclude canceled sales', () => {
    let buyStub: sinon.SinonStub
    let saleStub: sinon.SinonStub

    beforeEach(() => {
      buyStub = sinon.stub(BuyModel, 'aggregate')
      saleStub = sinon.stub(SaleModel, 'aggregate')
    })

    afterEach(() => {
      buyStub.restore()
      saleStub.restore()
    })

    it('includes estado: { $ne: "Cancelado" } in the SaleModel aggregate $match', async () => {
      saleStub.resolves([{ totalSales: 8000, salesCount: 30 }])
      buyStub.resolves([{ totalSales: 4000, salesCount: 15 }])

      await dataset.getAnnuallyDataGraph()

      // Inspect the aggregate pipeline args passed to the SaleModel
      const callArgs = saleStub.getCall(0).args[0]
      const matchStage = callArgs.find((stage: any) => stage.$match)
      expect(matchStage).to.not.equal(undefined)
      expect(matchStage.$match).to.have.property('estado')
      expect(matchStage.$match.estado).to.deep.equal({ $ne: 'Cancelado' })
    })

    it('returns ventas that reflects only non-canceled sales (stub simulates active-only total)', async () => {
      // Simulate what the aggregate returns when estado filter is active
      saleStub.resolves([{ totalSales: 5000, salesCount: 20 }])
      buyStub.resolves([{ totalSales: 3000, salesCount: 10 }])

      const result = await dataset.getAnnuallyDataGraph()

      // The year of the frozen date — we just verify the response structure
      expect(result).to.have.property('data')
      expect(result.data[0]).to.have.property('ventas', 5000)
      expect(result.data[0]).to.have.property('compras', 3000)
    })
  })

  // ─── P1 Sunday execution edge case ──────────────────────────────────────

  describe('getWeeklyData — P1 Sunday execution edge case', () => {
    let buyStub: sinon.SinonStub
    let saleStub: sinon.SinonStub
    let clock: sinon.SinonFakeTimers

    beforeEach(() => {
      buyStub = sinon.stub(BuyModel, 'aggregate')
      saleStub = sinon.stub(SaleModel, 'aggregate')
      // Freeze time to Sunday June 14, 2026 — the critical edge case
      // Old code (startOfWeek default Sunday) would anchor to next week: "15-06 a 21-06"
      // Fixed code (weekStartsOn: 1) anchors to current week:   "08-06 a 15-06"
      clock = sinon.useFakeTimers(new Date('2026-06-14T12:00:00-03:00'))
    })

    afterEach(() => {
      buyStub.restore()
      saleStub.restore()
      clock.restore()
    })

    it('returns current Monday-Sunday week when executed on Sunday — not the following week', async () => {
      saleStub.resolves([{ totalSales: 1000, salesCount: 5 }])
      buyStub.resolves([{ totalSales: 500, salesCount: 3 }])

      const simple = await dataset.getWeeklyData()

      // On Sunday June 14, the correct Mon-Sun interval is June 8 - June 14
      // The old bug anchored to the FOLLOWING week (June 15 - June 21)
      expect(simple[0].date).to.equal('08-06 a 15-06')
    })

    it('returns same Monday-Sunday interval as getWeeklyDataGraph on Sunday', async () => {
      saleStub.resolves([{ totalSales: 1000, salesCount: 5 }])
      buyStub.resolves([{ totalSales: 500, salesCount: 3 }])

      const simple = await dataset.getWeeklyData()
      const graph = await dataset.getWeeklyDataGraph()

      expect(simple[0].date).to.equal(graph.data[0].label)
      // Both must be "08-06 a 15-06" — the current Mon-Sun week, not next week
      expect(simple[0].date).to.equal('08-06 a 15-06')
      expect(graph.data[0].label).to.equal('08-06 a 15-06')
    })
  })

  // ─── getWeeklyData (triangulation — verifies pattern generalizes) ───────

  describe('getWeeklyData', () => {
    let buyStub: sinon.SinonStub
    let saleStub: sinon.SinonStub

    beforeEach(() => {
      buyStub = sinon.stub(BuyModel, 'aggregate')
      saleStub = sinon.stub(SaleModel, 'aggregate')
    })

    afterEach(() => {
      buyStub.restore()
      saleStub.restore()
    })

    it('returns buy item with differences when both periods have data', async () => {
      saleStub.onFirstCall().resolves([{ totalSales: 5000, salesCount: 20 }])
      saleStub.onSecondCall().resolves([{ totalSales: 4000, salesCount: 16 }])
      buyStub.onFirstCall().resolves([{ totalSales: 2000, salesCount: 8 }])
      buyStub.onSecondCall().resolves([{ totalSales: 2500, salesCount: 10 }])

      const result = await dataset.getWeeklyData()
      const buyItem = result[1]

      // (2000-2500)/2500 * 100 = -20.00
      expect(asNumber(buyItem.totalSalesDifference)).to.equal(-20)
      // (8-10)/10 * 100 = -20.00
      expect(asNumber(buyItem.salesCountDifference)).to.equal(-20)
      expect(buyItem).to.have.property('label', 'buy')
    })
  })
})
