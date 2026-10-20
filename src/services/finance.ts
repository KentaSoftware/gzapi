/**
 * FinanceService — Gestión Financiera unificada (Spec finance-rules-v1).
 * Reuses CashflowService derivation rules; adds projection, idle capital, insights.
 */

import cashflowService, { buildMovements, resolveCashDate } from './cashflow'
import SaleModel from '../models/sale'
import BuyModel from '../models/buy'
import ExpenseModel from '../models/expense'
import {
  FINANCE_RULES_VERSION,
  FinanceDashboard,
  FinanceHistoricalBlock,
  FinanceProjectionBlock,
  FinanceRulesConfig,
  ComparableMonthTotals
} from '../interfaces/finance.interface'
import {
  average,
  buildInsights,
  classifyLiquidity,
  computeIdleCapital,
  computeReserveMinimum,
  listComparableMonthWindows,
  round2
} from './financeRules'

const REQUIRED_COMPARABLE_MONTHS = 3

class FinanceService {
  async getRulesConfig (): Promise<FinanceRulesConfig> {
    return cashflowService.getOrCreateConfig()
  }

  async updateRulesConfig (patch: Partial<FinanceRulesConfig>): Promise<FinanceRulesConfig> {
    if (patch.reserveMonthsMultiplier !== undefined) {
      if (typeof patch.reserveMonthsMultiplier !== 'number' || patch.reserveMonthsMultiplier < 0) {
        throw Object.assign(new Error('reserveMonthsMultiplier must be a number >= 0'), { status: 400 })
      }
    }
    if (patch.idleCapitalRecommendMin !== undefined) {
      if (typeof patch.idleCapitalRecommendMin !== 'number' || patch.idleCapitalRecommendMin < 0) {
        throw Object.assign(new Error('idleCapitalRecommendMin must be a number >= 0'), { status: 400 })
      }
    }
    if (patch.openingBalance !== undefined) {
      if (typeof patch.openingBalance !== 'number' || isNaN(patch.openingBalance)) {
        throw Object.assign(new Error('openingBalance must be a number'), { status: 400 })
      }
    }
    return cashflowService.updateConfig(patch)
  }

  /**
   * Full dashboard for filtered historical period + next-month projection.
   */
  async getDashboard (startDate: Date, endDate: Date): Promise<FinanceDashboard> {
    if (startDate.getTime() > endDate.getTime()) {
      throw Object.assign(new Error('FINANCE_INVALID_PERIOD'), {
        status: 400,
        code: 'FINANCE_INVALID_PERIOD'
      })
    }

    const config = await this.getRulesConfig()
    const docs = await this.loadSourceDocs()

    const historical = this.buildHistorical(docs, config, startDate, endDate)
    const projection = this.buildProjection(docs, config, endDate, historical)
    const insights = buildInsights({
      projectionStatus: projection.status,
      idleCapital: projection.idleCapital,
      liquidityClass: projection.liquidityClass,
      reserveMinimum: projection.reserveMinimum,
      deficitAlertEnabled: config.deficitAlertEnabled,
      idleCapitalRecommendMin: config.idleCapitalRecommendMin
    })

    return {
      rulesVersion: FINANCE_RULES_VERSION,
      currency: 'ARS',
      generatedAt: new Date().toISOString(),
      historical,
      projection,
      insights,
      config
    }
  }

  private async loadSourceDocs (): Promise<{ sales: any[], buys: any[], expenses: any[] }> {
    const [sales, buys, expenses] = await Promise.all([
      SaleModel.find({ estado: { $ne: 'Cancelado' } }).lean(),
      BuyModel.find({ estado: 'paid' }).lean(),
      ExpenseModel.find({ isDeleted: { $ne: true } }).lean()
    ])
    return { sales, buys, expenses }
  }

  private buildHistorical (
    docs: { sales: any[], buys: any[], expenses: any[] },
    config: FinanceRulesConfig,
    startDate: Date,
    endDate: Date
  ): FinanceHistoricalBlock {
    const periodMovements = buildMovements(docs, { startDate, endDate })
    const totalInflows = round2(
      periodMovements.filter(m => m.type === 'inflow').reduce((s, m) => s + m.amount, 0)
    )
    const totalOutflows = round2(
      periodMovements.filter(m => m.type === 'outflow').reduce((s, m) => s + m.amount, 0)
    )
    const netCashFlow = round2(totalInflows - totalOutflows)
    const openingBalance = this.balanceBefore(docs, config.openingBalance, startDate)
    const closingBalance = round2(openingBalance + netCashFlow)

    return {
      status: 'ok',
      kind: 'historical',
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      openingBalance,
      totalInflows,
      totalOutflows,
      netCashFlow,
      closingBalance
    }
  }

  /** openingBalance + net of all movements with cash date < before. */
  private balanceBefore (
    docs: { sales: any[], buys: any[], expenses: any[] },
    openingBalance: number,
    before: Date
  ): number {
    const epoch = new Date(0)
    const justBefore = new Date(before.getTime() - 1)
    if (justBefore.getTime() < epoch.getTime()) return round2(openingBalance)
    const prior = buildMovements(docs, { startDate: epoch, endDate: justBefore })
    const net = prior.reduce(
      (s, m) => s + (m.type === 'inflow' ? m.amount : -m.amount),
      0
    )
    return round2(openingBalance + net)
  }

  private buildProjection (
    docs: { sales: any[], buys: any[], expenses: any[] },
    config: FinanceRulesConfig,
    asOf: Date,
    historical: FinanceHistoricalBlock
  ): FinanceProjectionBlock {
    // Project the calendar month immediately after asOf's month
    const projYear = asOf.getUTCFullYear()
    const projMonthIndex = asOf.getUTCMonth() + 1 // next month (0-11 math)
    let y = projYear
    let m = projMonthIndex
    if (m > 11) {
      m = 0
      y += 1
    }
    const projStart = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0))
    const projEnd = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999))
    const periodLabel = `${y}-${String(m + 1).padStart(2, '0')}`

    // Comparable months: 3 complete months before projected month
    const windows = listComparableMonthWindows(projStart, REQUIRED_COMPARABLE_MONTHS)
    const comparableMonths: ComparableMonthTotals[] = windows.map(w => {
      const movs = buildMovements(docs, { startDate: w.start, endDate: w.end })
      return {
        year: w.year,
        month: w.month,
        label: w.label,
        inflows: round2(movs.filter(x => x.type === 'inflow').reduce((s, x) => s + x.amount, 0)),
        outflows: round2(movs.filter(x => x.type === 'outflow').reduce((s, x) => s + x.amount, 0))
      }
    })

    // A month counts even with zero movements (ReqFunc-077) as long as it is a complete past month.
    // We always have 3 windows by construction; treat as insufficient only if asOf is too early
    // (not enough calendar history since epoch — practically always 3). Spec: need 3 complete months.
    if (windows.length < REQUIRED_COMPARABLE_MONTHS) {
      return this.emptyProjection(periodLabel, projStart, projEnd, 'insufficient_history')
    }

    // Soft check: if the earliest window start is after the oldest source document, still OK with zeros.
    // Insufficient only when we cannot form 3 windows — already handled.
    // Additional: if ALL sources empty AND business never started — still return zeros average (calculable).
    // Spec S-10: fewer than 3 complete comparable months — e.g. system just started mid-year:
    // If asOf is in the first months of existence we still produce 3 calendar months (may be all zero).
    // To honor "insufficient", require that at least one movement exists in the union of the 3 months
    // OR any movement exists before projStart. If zero history at all → insufficient.
    const anyHistoryBeforeProj = docs.sales.some(s => resolveCashDate(s) < projStart) ||
      docs.buys.some(b => resolveCashDate(b) < projStart) ||
      docs.expenses.some(e => resolveCashDate(e) < projStart)

    const anyInWindow = comparableMonths.some(c => c.inflows > 0 || c.outflows > 0)
    if (!anyHistoryBeforeProj && !anyInWindow) {
      return this.emptyProjection(
        periodLabel,
        projStart,
        projEnd,
        'insufficient_history',
        'No hay movimientos históricos previos suficientes para proyectar.'
      )
    }

    // Also insufficient if we don't have 3 fully elapsed months before "today"/asOf
    // (e.g. asOf is January 2nd → Dec, Nov, Oct exist as calendars — OK)
    const projectedInflows = average(comparableMonths.map(c => c.inflows))
    const projectedOutflows = average(comparableMonths.map(c => c.outflows))
    const openingBalance = historical.closingBalance
    const projectedClosingBalance = round2(openingBalance + projectedInflows - projectedOutflows)
    const reserveMinimum = computeReserveMinimum(projectedOutflows, config.reserveMonthsMultiplier)
    const idleCapital = computeIdleCapital(projectedClosingBalance, reserveMinimum)
    const liquidityClass = classifyLiquidity(projectedClosingBalance, reserveMinimum)

    return {
      status: 'ok',
      kind: 'projected',
      rulesVersion: FINANCE_RULES_VERSION,
      periodLabel,
      startDate: projStart.toISOString(),
      endDate: projEnd.toISOString(),
      openingBalance,
      projectedInflows,
      projectedOutflows,
      projectedClosingBalance,
      reserveMinimum,
      idleCapital,
      liquidityClass,
      comparableMonths
    }
  }

  private emptyProjection (
    periodLabel: string,
    start: Date,
    end: Date,
    status: FinanceProjectionBlock['status'],
    message?: string
  ): FinanceProjectionBlock {
    return {
      status,
      kind: 'projected',
      rulesVersion: FINANCE_RULES_VERSION,
      periodLabel,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      openingBalance: 0,
      projectedInflows: 0,
      projectedOutflows: 0,
      projectedClosingBalance: 0,
      reserveMinimum: 0,
      idleCapital: 0,
      liquidityClass: null,
      comparableMonths: [],
      message
    }
  }
}

export default new FinanceService()
