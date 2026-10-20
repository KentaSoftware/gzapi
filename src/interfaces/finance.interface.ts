/**
 * Finance module contracts — gestion-financiera Spec (finance-rules-v1).
 * Read-model only: no persisted ledger, snapshots or alerts.
 */

export const FINANCE_RULES_VERSION = 'finance-rules-v1' as const

export type LiquidityClass = 'liquidez' | 'necesidad' | 'en_reserva'

export type FinanceSectionStatus =
  | 'ok'
  | 'insufficient_history'
  | 'data_incomplete'
  | 'source_unavailable'
  | 'not_calculable'

export interface FinanceRulesConfig {
  /** Global opening balance (shared with cashflow). */
  openingBalance: number
  /**
   * Multiplier for minimum reserve = avgMonthlyOutflows * reserveMonthsMultiplier.
   * Spec default: 1 (one month of average expenses).
   */
  reserveMonthsMultiplier: number
  /** When true, emit visual alert for necesidad financiera. */
  deficitAlertEnabled: boolean
  /** Soft threshold (ARS) above which idle-capital recommendations are emphasized. */
  idleCapitalRecommendMin: number
}

export interface ComparableMonthTotals {
  year: number
  month: number // 1-12
  label: string
  inflows: number
  outflows: number
}

export interface FinanceHistoricalBlock {
  status: FinanceSectionStatus
  startDate: string
  endDate: string
  openingBalance: number
  totalInflows: number
  totalOutflows: number
  netCashFlow: number
  closingBalance: number
  kind: 'historical'
}

export interface FinanceProjectionBlock {
  status: FinanceSectionStatus
  kind: 'projected'
  rulesVersion: typeof FINANCE_RULES_VERSION
  periodLabel: string
  startDate: string
  endDate: string
  openingBalance: number
  projectedInflows: number
  projectedOutflows: number
  projectedClosingBalance: number
  reserveMinimum: number
  idleCapital: number
  liquidityClass: LiquidityClass | null
  comparableMonths: ComparableMonthTotals[]
  message?: string
}

export interface FinanceInsight {
  type: 'alert' | 'recommendation'
  severity: 'info' | 'warning' | 'critical'
  code: string
  title: string
  explanation: string
  rulesVersion: typeof FINANCE_RULES_VERSION
  disclaimer?: string
}

export interface FinanceDashboard {
  rulesVersion: typeof FINANCE_RULES_VERSION
  currency: 'ARS'
  generatedAt: string
  historical: FinanceHistoricalBlock
  projection: FinanceProjectionBlock
  insights: FinanceInsight[]
  config: FinanceRulesConfig
}
