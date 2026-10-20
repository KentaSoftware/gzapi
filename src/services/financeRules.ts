/**
 * finance-rules-v1 — pure calculation helpers (no I/O).
 * Spec: gestion-financiera-notes.md Restrict-14..19, ReqFunc-020..032.
 */

import {
  FINANCE_RULES_VERSION,
  FinanceInsight,
  LiquidityClass
} from '../interfaces/finance.interface'

export const DISCLAIMER_NO_ADVICE =
  'Orientación operativa informativa. No constituye asesoramiento financiero profesional ni implica ejecución de pagos, transferencias o inversiones.'

export function round2 (value: number): number {
  return parseFloat(value.toFixed(2))
}

/** Average of n values; 0 if empty. */
export function average (values: number[]): number {
  if (values.length === 0) return 0
  return round2(values.reduce((a, b) => a + b, 0) / values.length)
}

/**
 * Minimum reserve = avg monthly outflows * multiplier (default 1 month).
 */
export function computeReserveMinimum (
  avgMonthlyOutflows: number,
  reserveMonthsMultiplier: number
): number {
  return round2(Math.max(0, avgMonthlyOutflows) * Math.max(0, reserveMonthsMultiplier))
}

/** Idle capital = max(0, projectedClosing - reserveMinimum). */
export function computeIdleCapital (
  projectedClosingBalance: number,
  reserveMinimum: number
): number {
  return round2(Math.max(0, projectedClosingBalance - reserveMinimum))
}

export function classifyLiquidity (
  projectedClosingBalance: number,
  reserveMinimum: number
): LiquidityClass {
  if (projectedClosingBalance > reserveMinimum) return 'liquidez'
  if (projectedClosingBalance < reserveMinimum) return 'necesidad'
  return 'en_reserva'
}

/**
 * Returns the last `count` complete calendar months strictly before `asOf`.
 * Excludes the calendar month of `asOf` (ReqFunc-075/076).
 */
export function listComparableMonthWindows (
  asOf: Date,
  count: number
): Array<{ year: number, month: number, start: Date, end: Date, label: string }> {
  const windows: Array<{ year: number, month: number, start: Date, end: Date, label: string }> = []
  let y = asOf.getUTCFullYear()
  let m = asOf.getUTCMonth() // 0-11 of asOf month — we step back first

  for (let i = 0; i < count; i++) {
    m -= 1
    if (m < 0) {
      m = 11
      y -= 1
    }
    const start = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0))
    const end = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999))
    const label = `${y}-${String(m + 1).padStart(2, '0')}`
    windows.push({ year: y, month: m + 1, start, end, label })
  }

  // chronological order (oldest first)
  return windows.reverse()
}

export function buildInsights (params: {
  projectionStatus: string
  idleCapital: number
  liquidityClass: LiquidityClass | null
  reserveMinimum: number
  deficitAlertEnabled: boolean
  idleCapitalRecommendMin: number
}): FinanceInsight[] {
  const insights: FinanceInsight[] = []
  const { projectionStatus, idleCapital, liquidityClass, deficitAlertEnabled, idleCapitalRecommendMin } = params

  if (projectionStatus === 'insufficient_history') {
    insights.push({
      type: 'alert',
      severity: 'warning',
      code: 'FINANCE_INSUFFICIENT_HISTORY',
      title: 'Historial insuficiente para proyección',
      explanation:
        'Se requieren al menos tres meses calendario comparables completos (anteriores al mes proyectado) para calcular proyección, reserva mínima y capital ocioso.',
      rulesVersion: FINANCE_RULES_VERSION
    })
    return insights
  }

  if (liquidityClass === 'necesidad' && deficitAlertEnabled) {
    insights.push({
      type: 'alert',
      severity: 'critical',
      code: 'FINANCE_DEFICIT_RISK',
      title: 'Necesidad financiera proyectada',
      explanation:
        'El saldo proyectado queda por debajo de la reserva mínima. Se sugiere preservar liquidez y priorizar egresos operativos críticos.',
      rulesVersion: FINANCE_RULES_VERSION,
      disclaimer: DISCLAIMER_NO_ADVICE
    })
    insights.push({
      type: 'recommendation',
      severity: 'warning',
      code: 'FINANCE_REC_PRESERVE_LIQUIDITY',
      title: 'Preservar reserva de seguridad',
      explanation:
        'Revisar egresos no esenciales del próximo período y evitar compromisos que reduzcan aún más la reserva mínima calculada.',
      rulesVersion: FINANCE_RULES_VERSION,
      disclaimer: DISCLAIMER_NO_ADVICE
    })
  }

  if (liquidityClass === 'liquidez' && idleCapital > idleCapitalRecommendMin) {
    insights.push({
      type: 'recommendation',
      severity: 'info',
      code: 'FINANCE_REC_REVIEW_IDLE_CAPITAL',
      title: 'Capital ocioso detectado',
      explanation:
        `Hay un excedente estimado de ARS ${idleCapital.toFixed(2)} sobre la reserva mínima. Revisá oportunidades operativas (p. ej. reposición estratégica o renegociación de plazos) sin ejecutar acciones automáticas desde el sistema.`,
      rulesVersion: FINANCE_RULES_VERSION,
      disclaimer: DISCLAIMER_NO_ADVICE
    })
  }

  if (liquidityClass === 'en_reserva') {
    insights.push({
      type: 'recommendation',
      severity: 'info',
      code: 'FINANCE_REC_AT_RESERVE',
      title: 'Saldo en el límite de reserva',
      explanation:
        'El saldo proyectado iguala la reserva mínima: no hay capital ocioso ni déficit. Mantener seguimiento del flujo del próximo período.',
      rulesVersion: FINANCE_RULES_VERSION,
      disclaimer: DISCLAIMER_NO_ADVICE
    })
  }

  return insights
}
