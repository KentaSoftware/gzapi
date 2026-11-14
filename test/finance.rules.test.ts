/**
 * Unit tests for finance-rules-v2 (CUR-6 / avance 2).
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { expect } = require('chai')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  average,
  computeEffectiveReserve,
  computeIdleCapital,
  hasDeficitRisk,
  buildInsights,
  buildOpportunityCard,
  riskReserveMultiplier
} = require('../src/services/financeRules')

describe('finance-rules-v2 — CUR-6 formulas', () => {
  it('applies risk profile multipliers to reserve', () => {
    expect(riskReserveMultiplier('moderado')).to.equal(1)
    expect(riskReserveMultiplier('conservador')).to.equal(1.25)
    expect(riskReserveMultiplier('agresivo')).to.equal(0.75)
    expect(computeEffectiveReserve(400000, 'moderado')).to.equal(400000)
    expect(computeEffectiveReserve(400000, 'conservador')).to.equal(500000)
  })

  it('computes idle capital as max(0, saldo − reserva efectiva)', () => {
    expect(computeIdleCapital(600000, 500000)).to.equal(100000)
    expect(computeIdleCapital(400000, 500000)).to.equal(0)
  })

  it('flags deficit when below reserve or early threshold', () => {
    // saldo < reserva → always
    expect(hasDeficitRisk(400000, 500000, 20)).to.equal(true)
    // saldo above reserve but below 80% line? 480000 < 500000*0.8=400000? no
    expect(hasDeficitRisk(450000, 500000, 20)).to.equal(true) // 450k < 500k reserve
    // early: umbral 20% → line 400000; saldo 390000 < 400000 and also < 500000
    expect(hasDeficitRisk(390000, 500000, 20)).to.equal(true)
    // healthy
    expect(hasDeficitRisk(600000, 500000, 20)).to.equal(false)
  })

  it('averages weekly nets for projected series', () => {
    expect(average([100, 200, 300])).to.equal(200)
    expect(average([])).to.equal(0)
  })

  it('builds M2 insufficient history and disables ROI opportunity', () => {
    const insights = buildInsights({
      historySufficient: false,
      availableBalance: 800000,
      effectiveReserve: 500000,
      idleCapital: 300000,
      deficitAlertThresholdPercent: 20,
      minExpectedRoiPercent: 18
    })
    expect(insights.some((i: any) => i.code === 'FINANCE_INSUFFICIENT_HISTORY')).to.equal(true)

    const card = buildOpportunityCard({
      historySufficient: false,
      idleCapital: 300000,
      deficitRisk: false,
      minExpectedRoiPercent: 18
    })
    expect(card.code).to.equal('CAPITAL_OCIOSO_NO_DETECTADO')
    expect(card.roiEnabled).to.equal(false)
  })

  it('builds capital ocioso opportunity with reference ROI when healthy', () => {
    const card = buildOpportunityCard({
      historySufficient: true,
      idleCapital: 125000,
      deficitRisk: false,
      minExpectedRoiPercent: 18
    })
    expect(card.code).to.equal('CAPITAL_OCIOSO_DETECTADO')
    expect(card.referenceRoiPercent).to.equal(18)
    expect(card.roiEnabled).to.equal(true)
    expect(card.disclaimer).to.be.a('string')
  })
})
