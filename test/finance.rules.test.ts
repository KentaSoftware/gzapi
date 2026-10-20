/**
 * Minimal unit tests for finance-rules-v1 pure helpers (S-03 / S-04 style).
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { expect } = require('chai')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  average,
  computeReserveMinimum,
  computeIdleCapital,
  classifyLiquidity,
  listComparableMonthWindows,
  buildInsights
} = require('../src/services/financeRules')

describe('finance-rules-v1 — projection math (S-03/S-04)', () => {
  it('averages three comparable months for projected inflows/outflows', () => {
    expect(average([900, 1200, 1500])).to.equal(1200)
    expect(average([300, 600, 900])).to.equal(600)
  })

  it('computes projected closing, reserve and idle capital', () => {
    const projectedInflows = 1200
    const projectedOutflows = 600
    const opening = 600
    const projectedClosing = opening + projectedInflows - projectedOutflows
    expect(projectedClosing).to.equal(1200)

    const reserve = computeReserveMinimum(projectedOutflows, 1)
    expect(reserve).to.equal(600)

    const idle = computeIdleCapital(projectedClosing, reserve)
    expect(idle).to.equal(600)
    expect(classifyLiquidity(projectedClosing, reserve)).to.equal('liquidez')
  })

  it('classifies necesidad and en_reserva', () => {
    expect(classifyLiquidity(400, 600)).to.equal('necesidad')
    expect(classifyLiquidity(600, 600)).to.equal('en_reserva')
    expect(computeIdleCapital(400, 600)).to.equal(0)
  })

  it('lists 3 complete months before projected month (excludes current)', () => {
    // Projecting from Oct 2026 → windows should be Jul, Aug, Sep 2026
    const asOfProjectedStart = new Date(Date.UTC(2026, 9, 1)) // Oct 1
    const windows = listComparableMonthWindows(asOfProjectedStart, 3)
    expect(windows).to.have.length(3)
    expect(windows.map((w: any) => w.label)).to.deep.equal(['2026-07', '2026-08', '2026-09'])
  })

  it('builds idle-capital recommendation with disclaimer', () => {
    const insights = buildInsights({
      projectionStatus: 'ok',
      idleCapital: 600,
      liquidityClass: 'liquidez',
      reserveMinimum: 600,
      deficitAlertEnabled: true,
      idleCapitalRecommendMin: 0
    })
    expect(insights.some((i: any) => i.code === 'FINANCE_REC_REVIEW_IDLE_CAPITAL')).to.equal(true)
    expect(insights[0].disclaimer || insights.find((i: any) => i.disclaimer)?.disclaimer).to.be.a('string')
  })
})
