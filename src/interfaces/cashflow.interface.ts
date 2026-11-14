/**
 * Cashflow domain interfaces — cash-flow-real-v1 + finance CUR-6 knobs (avance 2).
 */

export type FinanceRiskProfile = 'conservador' | 'moderado' | 'agresivo'

export interface CashflowMovement {
  /** Resolved cash date: paidAt > fecha > createdAt */
  date: Date
  /** Direction of cash flow */
  type: 'inflow' | 'outflow'
  /** Monetary amount in plain decimal (ARS pesos) */
  amount: number
  /** Source collection */
  source: 'sale' | 'buy' | 'expense'
  /** Human-readable description (e.g. client name, provider, category) */
  description: string
  /** MongoDB ObjectId as string for traceability */
  sourceId: string
}

export interface CashflowSummary {
  openingBalance: number
  totalInflows: number
  totalOutflows: number
  /** netCashFlow = totalInflows - totalOutflows */
  netCashFlow: number
  /** closingBalance = openingBalance + netCashFlow */
  closingBalance: number
}

/**
 * CashflowTimelineEntry — flat movement ordered by cashDate ascending.
 */
export type CashflowTimelineEntry = CashflowMovement

export interface CashflowConfig {
  openingBalance: number
  /** CUR-6 — Reserva mínima de seguridad (ARS absoluto). */
  reserveMinimumAmount: number
  /** CUR-6 — Umbral de alerta por déficit (%). */
  deficitAlertThresholdPercent: number
  /** CUR-6 — ROI mínimo esperado (%) — umbral de análisis. */
  minExpectedRoiPercent: number
  /** CUR-6 — Plazos de evaluación histórica (días). */
  historyEvaluationDays: number
  /** CUR-6 — Perfil de riesgo. */
  riskProfile: FinanceRiskProfile
}
