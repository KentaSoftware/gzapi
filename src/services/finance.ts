/**
 * FinanceService — CUR-5 / CUR-6 avance 2 (finance-rules-v2).
 */

import cashflowService, { buildMovements, resolveCashDate } from './cashflow'
import SaleModel from '../models/sale'
import BuyModel from '../models/buy'
import ExpenseModel from '../models/expense'
import {
  FINANCE_RULES_VERSION,
  FinanceDashboard,
  FinanceExpenseDistributionSlice,
  FinanceRulesConfig,
  FinanceWeeklyPoint
} from '../interfaces/finance.interface'
import type { CashflowConfig, CashflowMovement } from '../interfaces/cashflow.interface'
import {
  addUtcDays,
  average,
  buildInsights,
  buildOpportunityCard,
  computeEffectiveReserve,
  computeIdleCapital,
  hasDeficitRisk,
  round2,
  startOfUtcWeek
} from './financeRules'

class FinanceService {
  /** Rules shown/edited from /finance (excludes openingBalance). */
  async getRulesConfig (): Promise<FinanceRulesConfig> {
    const full = await cashflowService.getOrCreateConfig()
    return this.toRulesConfig(full)
  }

  async updateRulesConfig (patch: Partial<FinanceRulesConfig>): Promise<FinanceRulesConfig> {
    this.validateRulesPatch(patch)
    const full = await cashflowService.updateConfig(patch)
    return this.toRulesConfig(full)
  }

  async getDashboard (startDate: Date, endDate: Date): Promise<FinanceDashboard> {
    if (startDate.getTime() > endDate.getTime()) {
      throw Object.assign(new Error('FINANCE_INVALID_PERIOD'), {
        status: 400,
        code: 'FINANCE_INVALID_PERIOD'
      })
    }

    const config = await cashflowService.getOrCreateConfig()
    const docs = await this.loadSourceDocs()
    const periodMovements = buildMovements(docs, { startDate, endDate })
    const emptyPeriod = periodMovements.length === 0

    const totalInflows = round2(
      periodMovements.filter(m => m.type === 'inflow').reduce((s, m) => s + m.amount, 0)
    )
    const totalOutflows = round2(
      periodMovements.filter(m => m.type === 'outflow').reduce((s, m) => s + m.amount, 0)
    )
    const netCashFlow = round2(totalInflows - totalOutflows)
    const currentBalance = this.balanceThrough(docs, config.openingBalance, endDate)

    const effectiveReserve = computeEffectiveReserve(config.reserveMinimumAmount, config.riskProfile)
    const idleCapital = computeIdleCapital(currentBalance, effectiveReserve)
    const historySufficient = this.isHistorySufficient(docs, endDate, config.historyEvaluationDays)
    const deficitRisk = hasDeficitRisk(
      currentBalance,
      effectiveReserve,
      config.deficitAlertThresholdPercent
    )

    const insights = buildInsights({
      historySufficient,
      availableBalance: currentBalance,
      effectiveReserve,
      idleCapital,
      deficitAlertThresholdPercent: config.deficitAlertThresholdPercent,
      minExpectedRoiPercent: config.minExpectedRoiPercent
    })

    const opportunity = buildOpportunityCard({
      historySufficient,
      idleCapital,
      deficitRisk,
      minExpectedRoiPercent: config.minExpectedRoiPercent
    })

    const timeline = [...periodMovements].sort(
      (a, b) => a.date.getTime() - b.date.getTime()
    )
    const recentMovements = [...periodMovements]
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .slice(0, 8)

    return {
      rulesVersion: FINANCE_RULES_VERSION,
      currency: 'ARS',
      generatedAt: new Date().toISOString(),
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      emptyPeriod,
      kpis: {
        currentBalance,
        totalInflows,
        totalOutflows,
        netCashFlow,
        idleCapital,
        effectiveReserve
      },
      timeline,
      expenseDistribution: this.buildExpenseDistribution(docs.expenses, startDate, endDate),
      weeklyProjection: this.buildWeeklyProjection(
        docs,
        startDate,
        endDate,
        config.historyEvaluationDays
      ),
      recentMovements,
      insights,
      opportunity,
      config,
      historySufficient
    }
  }

  private toRulesConfig (full: CashflowConfig): FinanceRulesConfig {
    return {
      reserveMinimumAmount: full.reserveMinimumAmount,
      deficitAlertThresholdPercent: full.deficitAlertThresholdPercent,
      minExpectedRoiPercent: full.minExpectedRoiPercent,
      historyEvaluationDays: full.historyEvaluationDays,
      riskProfile: full.riskProfile
    }
  }

  private validateRulesPatch (patch: Partial<FinanceRulesConfig>): void {
    if (patch.reserveMinimumAmount !== undefined) {
      if (typeof patch.reserveMinimumAmount !== 'number' || patch.reserveMinimumAmount < 0 || isNaN(patch.reserveMinimumAmount)) {
        throw Object.assign(new Error('reserveMinimumAmount must be a number >= 0'), { status: 400 })
      }
    }
    if (patch.deficitAlertThresholdPercent !== undefined) {
      if (
        typeof patch.deficitAlertThresholdPercent !== 'number' ||
        patch.deficitAlertThresholdPercent < 0 ||
        isNaN(patch.deficitAlertThresholdPercent)
      ) {
        throw Object.assign(new Error('deficitAlertThresholdPercent must be a number >= 0'), { status: 400 })
      }
    }
    if (patch.minExpectedRoiPercent !== undefined) {
      if (
        typeof patch.minExpectedRoiPercent !== 'number' ||
        patch.minExpectedRoiPercent < 0 ||
        isNaN(patch.minExpectedRoiPercent)
      ) {
        throw Object.assign(new Error('minExpectedRoiPercent must be a number >= 0'), { status: 400 })
      }
    }
    if (patch.historyEvaluationDays !== undefined) {
      if (
        typeof patch.historyEvaluationDays !== 'number' ||
        !Number.isInteger(patch.historyEvaluationDays) ||
        patch.historyEvaluationDays < 1
      ) {
        throw Object.assign(new Error('historyEvaluationDays must be an integer >= 1'), { status: 400 })
      }
    }
    if (patch.riskProfile !== undefined) {
      if (!['conservador', 'moderado', 'agresivo'].includes(patch.riskProfile)) {
        throw Object.assign(new Error('riskProfile must be conservador|moderado|agresivo'), { status: 400 })
      }
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

  /** openingBalance + net of all movements with cash date <= through. */
  private balanceThrough (
    docs: { sales: any[], buys: any[], expenses: any[] },
    openingBalance: number,
    through: Date
  ): number {
    const epoch = new Date(0)
    const movs = buildMovements(docs, { startDate: epoch, endDate: through })
    const net = movs.reduce(
      (s, m) => s + (m.type === 'inflow' ? m.amount : -m.amount),
      0
    )
    return round2(openingBalance + net)
  }

  private isHistorySufficient (
    docs: { sales: any[], buys: any[], expenses: any[] },
    asOf: Date,
    historyEvaluationDays: number
  ): boolean {
    const dates: number[] = []
    for (const s of docs.sales) {
      const d = resolveCashDate(s)
      if (d <= asOf) dates.push(d.getTime())
    }
    for (const b of docs.buys) {
      const d = resolveCashDate(b)
      if (d <= asOf) dates.push(d.getTime())
    }
    for (const e of docs.expenses) {
      const d = resolveCashDate(e)
      if (d <= asOf) dates.push(d.getTime())
    }
    if (dates.length === 0) return false
    dates.sort((a, b) => a - b)
    const spanDays = (dates[dates.length - 1] - dates[0]) / (24 * 60 * 60 * 1000)
    return spanDays >= historyEvaluationDays - 1e-9
  }

  private buildExpenseDistribution (
    expenses: any[],
    startDate: Date,
    endDate: Date
  ): FinanceExpenseDistributionSlice[] {
    const map = new Map<string, number>()
    for (const e of expenses) {
      const d = resolveCashDate(e)
      if (d < startDate || d > endDate) continue
      const cat = typeof e.category === 'string' && e.category.trim() !== '' ? e.category.trim() : 'Sin categoría'
      const amount = Number(e.amountCents ?? 0) / 100
      map.set(cat, round2((map.get(cat) ?? 0) + amount))
    }
    return [...map.entries()]
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount)
  }

  /**
   * Up to 4 weeks covering the filter range.
   * Real = net of that week; Projected = average weekly net over historyEvaluationDays lookback.
   */
  private buildWeeklyProjection (
    docs: { sales: any[], buys: any[], expenses: any[] },
    startDate: Date,
    endDate: Date,
    historyEvaluationDays: number
  ): FinanceWeeklyPoint[] {
    const lookbackStart = addUtcDays(startDate, -historyEvaluationDays)
    const histMovs = buildMovements(docs, {
      startDate: lookbackStart,
      endDate: addUtcDays(startDate, -1)
    })
    const histWeeklyNets = this.weeklyNets(histMovs, lookbackStart, addUtcDays(startDate, -1))
    const projectedNet = average(histWeeklyNets)

    const weekStarts: Date[] = []
    let cursor = startOfUtcWeek(startDate)
    const rangeEnd = endDate.getTime()
    while (cursor.getTime() <= rangeEnd && weekStarts.length < 4) {
      weekStarts.push(new Date(cursor.getTime()))
      cursor = addUtcDays(cursor, 7)
    }
    if (weekStarts.length === 0) {
      weekStarts.push(startOfUtcWeek(startDate))
    }

    const periodMovs = buildMovements(docs, { startDate, endDate })
    return weekStarts.map((ws, index) => {
      const we = addUtcDays(ws, 6)
      we.setUTCHours(23, 59, 59, 999)
      const sliceStart = ws.getTime() < startDate.getTime() ? startDate : ws
      const sliceEnd = we.getTime() > endDate.getTime() ? endDate : we
      const realNet = round2(
        periodMovs
          .filter(m => m.date >= sliceStart && m.date <= sliceEnd)
          .reduce((s, m) => s + (m.type === 'inflow' ? m.amount : -m.amount), 0)
      )
      return {
        label: `Sem ${index + 1}`,
        weekIndex: index + 1,
        startDate: sliceStart.toISOString(),
        endDate: sliceEnd.toISOString(),
        realNet,
        projectedNet
      }
    })
  }

  private weeklyNets (movements: CashflowMovement[], from: Date, to: Date): number[] {
    if (to.getTime() < from.getTime()) return []
    const nets: number[] = []
    let ws = startOfUtcWeek(from)
    while (ws.getTime() <= to.getTime()) {
      const we = addUtcDays(ws, 6)
      we.setUTCHours(23, 59, 59, 999)
      const sliceStart = ws.getTime() < from.getTime() ? from : ws
      const sliceEnd = we.getTime() > to.getTime() ? to : we
      // Only count complete weeks inside lookback (at least 7 days span or last partial if sole)
      const net = round2(
        movements
          .filter(m => m.date >= sliceStart && m.date <= sliceEnd)
          .reduce((s, m) => s + (m.type === 'inflow' ? m.amount : -m.amount), 0)
      )
      nets.push(net)
      ws = addUtcDays(ws, 7)
    }
    return nets
  }
}

export default new FinanceService()
