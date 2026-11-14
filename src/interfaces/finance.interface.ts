/**
 * Finance module contracts — CUR-5 / CUR-6 avance 2 (finance-rules-v2).
 */

import type { CashflowConfig, CashflowMovement, FinanceRiskProfile } from './cashflow.interface'

export const FINANCE_RULES_VERSION = 'finance-rules-v2' as const

export type { FinanceRiskProfile }

/** Rules editable from /finance (CU-012). openingBalance stays on /cashflow only. */
export interface FinanceRulesConfig {
  reserveMinimumAmount: number
  deficitAlertThresholdPercent: number
  minExpectedRoiPercent: number
  historyEvaluationDays: number
  riskProfile: FinanceRiskProfile
}

export interface FinanceKpis {
  /** Saldo Actual at filter end (baseline openingBalance + cumulative net through endDate). */
  currentBalance: number
  totalInflows: number
  totalOutflows: number
  netCashFlow: number
  /** Capital ocioso vs effective reserve (CUR-6). */
  idleCapital: number
  effectiveReserve: number
}

export interface FinanceExpenseDistributionSlice {
  category: string
  amount: number
}

export interface FinanceWeeklyPoint {
  label: string
  weekIndex: number
  startDate: string
  endDate: string
  realNet: number
  projectedNet: number
}

export interface FinanceOpportunityCard {
  code: 'CAPITAL_OCIOSO_DETECTADO' | 'CAPITAL_OCIOSO_NO_DETECTADO'
  title: string
  explanation: string
  /** ROI de referencia (umbral configurado); null si historial insuficiente. */
  referenceRoiPercent: number | null
  idleCapital: number
  roiEnabled: boolean
  disclaimer?: string
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
  startDate: string
  endDate: string
  /** True when the filtered period has zero movements (CUR-5 empty state). */
  emptyPeriod: boolean
  kpis: FinanceKpis
  timeline: CashflowMovement[]
  expenseDistribution: FinanceExpenseDistributionSlice[]
  weeklyProjection: FinanceWeeklyPoint[]
  recentMovements: CashflowMovement[]
  insights: FinanceInsight[]
  opportunity: FinanceOpportunityCard
  /** Full cashflow config including openingBalance (for server use); UI rules omit openingBalance. */
  config: CashflowConfig
  historySufficient: boolean
}
