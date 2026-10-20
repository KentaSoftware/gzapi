/**
 * Cashflow domain interfaces — TICKET-002: cash-flow-real-v1
 *
 * These types describe the shape of cashflow aggregation results returned
 * by CashflowService and exposed through the /cashflow REST endpoints.
 *
 * Design constraint: all monetary amounts are plain decimals (not cents).
 * Expense.amountCents is normalized (÷ 100) inside CashflowService before
 * these types are populated.
 */

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
 * Alias of CashflowMovement; kept as a named type for future extension.
 */
export type CashflowTimelineEntry = CashflowMovement

export interface CashflowConfig {
  openingBalance: number
  /** CU-012 / finance-rules-v1 knobs (defaults applied if missing). */
  reserveMonthsMultiplier: number
  deficitAlertEnabled: boolean
  idleCapitalRecommendMin: number
}
