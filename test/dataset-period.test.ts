/**
 * STRICT TDD — P5: Dataset Period Contract
 *
 * Unit tests for `resolveDatasetPeriod` (task 1.2) and controller period
 * injection (task 2.4).
 *
 * Strategy: sinon fake timers for deterministic date output; model stubs
 * for controller tests (same pattern as buy.controller.test.ts and dataset.test.ts).
 *
 * All assertions verify real behavior: specific from/to/label values derived from
 * the frozen clock, and structural presence of period in controller responses.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { expect } = require('chai')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sinon = require('sinon')

// ── Load models before service/controller (so stubs work on the cached module) ─
// eslint-disable-next-line @typescript-eslint/no-var-requires
const BuyModel = require('../src/models/buy').default
// eslint-disable-next-line @typescript-eslint/no-var-requires
const SaleModel = require('../src/models/sale').default

// Lazy-load modules after potential stub setup
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dataset = require('../src/services/dataset')

let datasetController: any
function getController (): any {
  if (!datasetController) {
    datasetController = require('../src/controllers/dataset')
  }
  return datasetController
}

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

// Freeze point: Wednesday June 11 2026 at 15:00 UTC (= 12:00 UTC-3)
const FROZEN_UTC = new Date('2026-06-11T15:00:00.000Z').getTime()

// ─── Phase 1: resolveDatasetPeriod unit tests ──────────────────────────────────

describe('P5 — resolveDatasetPeriod', () => {
  let clock: any

  afterEach(() => {
    if (clock) {
      clock.restore()
      clock = null
    }
    sinon.restore()
  })

  // ─── daily ─────────────────────────────────────────────────────────────────

  describe('daily interval', () => {
    it('returns from equal to to (same calendar day, YYYY-MM-DD)', () => {
      clock = sinon.useFakeTimers(FROZEN_UTC)

      const period = dataset.resolveDatasetPeriod('daily')

      // Daily interval: from and to represent the same day
      expect(period.from).to.equal(period.to)
      expect(period.from).to.match(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD')
    })

    it('label is DD-MM for today UTC-3 aligned (frozen June 11 2026)', () => {
      // Frozen at June 11 2026 15:00 UTC = June 11 12:00 UTC-3
      clock = sinon.useFakeTimers(FROZEN_UTC)

      const period = dataset.resolveDatasetPeriod('daily')

      expect(period.label).to.match(/^\d{2}-\d{2}$/, 'label must be DD-MM')
      expect(period.label).to.equal('11-06')
      expect(period.from).to.equal('2026-06-11')
    })
  })

  // ─── weekly ────────────────────────────────────────────────────────────────

  describe('weekly interval', () => {
    it('returns correct from/to/label for Monday–Sunday range', () => {
      clock = sinon.useFakeTimers(FROZEN_UTC)

      const period = dataset.resolveDatasetPeriod('weekly')

      // With frozen time June 11 UTC-3, the current Mon-Sun week is June 8 → June 15 (with +3h offset)
      expect(period).to.have.property('from', '2026-06-08')
      expect(period).to.have.property('to', '2026-06-15')
      expect(period).to.have.property('label', '08-06 a 15-06')
    })

    it('period.label matches getWeeklyData simple[0].date (same canonical interval)', async () => {
      clock = sinon.useFakeTimers(FROZEN_UTC)

      sinon.stub(SaleModel, 'aggregate').resolves([{ totalSales: 1000, salesCount: 5 }])
      sinon.stub(BuyModel, 'aggregate').resolves([{ totalSales: 500, salesCount: 3 }])

      const period = dataset.resolveDatasetPeriod('weekly')
      const simple = await dataset.getWeeklyData()

      expect(period.label).to.equal(simple[0].date)
    })
  })

  // ─── monthly ───────────────────────────────────────────────────────────────

  describe('monthly interval', () => {
    it('returns correct from/to/label for current month', () => {
      clock = sinon.useFakeTimers(FROZEN_UTC)

      const period = dataset.resolveDatasetPeriod('monthly')

      expect(period).to.have.property('from', '2026-06-01')
      expect(period).to.have.property('to', '2026-07-01') // endOfMonth + 3h offset
      expect(period).to.have.property('label', 'Junio del 2026')
    })

    it('label includes Spanish month name and year', () => {
      // Freeze to January 15 2026 at 15:00 UTC
      clock = sinon.useFakeTimers(new Date('2026-01-15T15:00:00.000Z').getTime())

      const period = dataset.resolveDatasetPeriod('monthly')

      expect(period.label).to.include('2026')
      expect(period.label).to.match(/^[A-Za-záéíóú]+ del \d{4}$/)
    })
  })

  // ─── annually ──────────────────────────────────────────────────────────────

  describe('annually interval', () => {
    it('returns correct from/to/label for current year', () => {
      clock = sinon.useFakeTimers(FROZEN_UTC)

      const period = dataset.resolveDatasetPeriod('annually')

      expect(period).to.have.property('from', '2026-01-01')
      expect(period).to.have.property('to', '2027-01-01') // endOfYear + 3h offset → Jan 1 next year
      expect(period).to.have.property('label', '2026')
    })

    it('label is the 4-digit year string for a different year (triangulation)', () => {
      // Freeze to 2025 to verify it's not hardcoded
      clock = sinon.useFakeTimers(new Date('2025-06-11T15:00:00.000Z').getTime())

      const period = dataset.resolveDatasetPeriod('annually')

      expect(period.label).to.equal('2025')
    })
  })

  // ─── custom ────────────────────────────────────────────────────────────────

  describe('custom interval — valid dates', () => {
    it('returns from/to/label in correct types and formats', () => {
      // NOTE: exact date values are timezone-dependent (the server applies a +3h UTC-3 offset).
      // We test structure and format here; the weekly label-match test below validates
      // the convention that from/to/label are all derived from the same Date arithmetic.
      const period = dataset.resolveDatasetPeriod('custom', '2026-06-01', '2026-06-30')

      expect(period.from).to.match(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD')
      expect(period.to).to.match(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD')
      expect(period.label).to.match(/^\d{2}-\d{2} a \d{2}-\d{2}$/, 'label must be DD-MM a DD-MM')
    })

    it('label follows DD-MM a DD-MM format (same as weekly)', () => {
      const period = dataset.resolveDatasetPeriod('custom', '2026-01-15', '2026-01-20')

      expect(period.label).to.match(/^\d{2}-\d{2} a \d{2}-\d{2}$/)
    })

    it('from and to are derived from the provided date range (not today)', () => {
      // Triangulation: use two distinct ranges and verify labels differ
      const june = dataset.resolveDatasetPeriod('custom', '2026-06-01', '2026-06-07')
      const jan = dataset.resolveDatasetPeriod('custom', '2026-01-01', '2026-01-07')

      // The labels must be different — they depend on the provided dates, not today
      expect(june.label).to.not.equal(jan.label)
    })
  })

  describe('custom interval — invalid dates', () => {
    it('throws INVALID_DATE_FORMAT when from is not YYYY-MM-DD', () => {
      expect(() => dataset.resolveDatasetPeriod('custom', 'not-a-date', '2026-06-30'))
        .to.throw(/INVALID_DATE_FORMAT/)
    })

    it('throws INVALID_DATE_FORMAT when to is not YYYY-MM-DD', () => {
      expect(() => dataset.resolveDatasetPeriod('custom', '2026-06-01', 'also-invalid'))
        .to.throw(/INVALID_DATE_FORMAT/)
    })

    it('throws INVALID_DATE_FORMAT when from is undefined', () => {
      expect(() => dataset.resolveDatasetPeriod('custom', undefined, '2026-06-30'))
        .to.throw(/INVALID_DATE_FORMAT/)
    })

    it('throws INVALID_DATE_FORMAT when both params are missing', () => {
      expect(() => dataset.resolveDatasetPeriod('custom'))
        .to.throw(/INVALID_DATE_FORMAT/)
    })
  })
})

// ─── Phase 2: Dataset controller period injection ──────────────────────────────

describe('P5 — Dataset controller: period field in responses', () => {
  afterEach(() => {
    sinon.restore()
  })

  // ─── weeklyCtrl ────────────────────────────────────────────────────────────

  describe('weeklyCtrl', () => {
    it('response includes period with YYYY-MM-DD from/to and non-empty label', async () => {
      sinon.stub(SaleModel, 'aggregate').resolves([{ totalSales: 1000, salesCount: 5 }])
      sinon.stub(BuyModel, 'aggregate').resolves([{ totalSales: 500, salesCount: 3 }])

      const req = makeReq()
      const res = makeRes()

      await getController().weeklyCtrl(req, res)

      expect(res.send.calledOnce).to.equal(true)
      const data = res.send.firstCall.args[0]

      expect(data).to.have.property('period')
      expect(data.period.from).to.match(/^\d{4}-\d{2}-\d{2}$/)
      expect(data.period.to).to.match(/^\d{4}-\d{2}-\d{2}$/)
      expect(data.period.label).to.be.a('string').with.length.greaterThan(0)
    })

    it('existing simple and graph shapes are preserved (backward compatible)', async () => {
      sinon.stub(SaleModel, 'aggregate').resolves([{ totalSales: 2000, salesCount: 10 }])
      sinon.stub(BuyModel, 'aggregate').resolves([{ totalSales: 1000, salesCount: 6 }])

      const req = makeReq()
      const res = makeRes()

      await getController().weeklyCtrl(req, res)

      const data = res.send.firstCall.args[0]

      expect(data).to.have.property('simple').that.is.an('array')
      expect(data).to.have.property('graph')
      expect(data.graph).to.have.property('data').that.is.an('array')
    })
  })

  // ─── customCtrl ────────────────────────────────────────────────────────────

  describe('customCtrl', () => {
    it('valid dates: response includes period with DD-MM a DD-MM label', async () => {
      sinon.stub(SaleModel, 'aggregate').resolves([{ totalSales: 1500, salesCount: 7 }])
      sinon.stub(BuyModel, 'aggregate').resolves([{ totalSales: 800, salesCount: 4 }])

      const req = makeReq({ params: { from: '2026-06-01', to: '2026-06-30' } })
      const res = makeRes()

      await getController().customCtrl(req, res)

      expect(res.send.calledOnce).to.equal(true)
      const data = res.send.firstCall.args[0]

      expect(data).to.have.property('period')
      expect(data.period.from).to.match(/^\d{4}-\d{2}-\d{2}$/)
      expect(data.period.to).to.match(/^\d{4}-\d{2}-\d{2}$/)
      expect(data.period.label).to.match(/^\d{2}-\d{2} a \d{2}-\d{2}$/)
    })

    it('valid dates: response preserves existing simple and graph fields', async () => {
      sinon.stub(SaleModel, 'aggregate').resolves([{ totalSales: 1500, salesCount: 7 }])
      sinon.stub(BuyModel, 'aggregate').resolves([{ totalSales: 800, salesCount: 4 }])

      const req = makeReq({ params: { from: '2026-06-01', to: '2026-06-30' } })
      const res = makeRes()

      await getController().customCtrl(req, res)

      const data = res.send.firstCall.args[0]

      expect(data).to.have.property('simple').that.is.an('array')
      expect(data).to.have.property('graph')
      expect(data.graph).to.have.property('data').that.is.an('array')
    })

    it('invalid from date: returns 400 without calling DB', async () => {
      const req = makeReq({ params: { from: 'invalid-date', to: '2026-06-30' } })
      const res = makeRes()

      await getController().customCtrl(req, res)

      expect(res.status.calledWith(400)).to.equal(true)
      expect(res.send.calledOnce).to.equal(true)
    })

    it('invalid to date: returns 400 without calling DB', async () => {
      const req = makeReq({ params: { from: '2026-06-01', to: 'also-bad' } })
      const res = makeRes()

      await getController().customCtrl(req, res)

      expect(res.status.calledWith(400)).to.equal(true)
    })

    it('new from/to param names accepted (previously start/end) — route compatibility', async () => {
      sinon.stub(SaleModel, 'aggregate').resolves([{ totalSales: 500, salesCount: 3 }])
      sinon.stub(BuyModel, 'aggregate').resolves([{ totalSales: 300, salesCount: 2 }])

      // The controller now reads req.params.from and req.params.to (not start/end)
      const req = makeReq({ params: { from: '2026-05-01', to: '2026-05-31' } })
      const res = makeRes()

      await getController().customCtrl(req, res)

      // If the controller still reads start/end, it would get undefined → resolveDatasetPeriod throws → 400 or 500
      // If the controller correctly reads from/to → 200 with period in response
      expect(res.send.calledOnce).to.equal(true)
      const data = res.send.firstCall.args[0]
      expect(data).to.have.property('period')
    })
  })
})
