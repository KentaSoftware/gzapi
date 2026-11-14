/**
 * finance-rules-v2 — CUR-6 formulas (decisiones-finanzas-avance-2.md).
 */

import {
  FINANCE_RULES_VERSION,
  FinanceInsight,
  FinanceOpportunityCard,
  FinanceRiskProfile
} from '../interfaces/finance.interface'

export const DISCLAIMER_NO_ADVICE =
  'Orientación operativa informativa. No constituye asesoramiento financiero profesional ni implica ejecución de pagos, transferencias o inversiones. El ROI mostrado es umbral/referencia de análisis, no una garantía de rentabilidad.'

export function round2 (value: number): number {
  return parseFloat(value.toFixed(2))
}

export function average (values: number[]): number {
  if (values.length === 0) return 0
  return round2(values.reduce((a, b) => a + b, 0) / values.length)
}

/** Risk profile → multiplier on configured reserve (CUR-6 simple rule). */
export function riskReserveMultiplier (profile: FinanceRiskProfile): number {
  switch (profile) {
    case 'conservador':
      return 1.25
    case 'agresivo':
      return 0.75
    case 'moderado':
    default:
      return 1
  }
}

export function computeEffectiveReserve (
  reserveMinimumAmount: number,
  riskProfile: FinanceRiskProfile
): number {
  return round2(Math.max(0, reserveMinimumAmount) * riskReserveMultiplier(riskProfile))
}

/** Capital ocioso = max(0, saldoDisponible − reserva efectiva). */
export function computeIdleCapital (
  availableBalance: number,
  effectiveReserve: number
): number {
  return round2(Math.max(0, availableBalance - effectiveReserve))
}

/**
 * Deficit risk (M6):
 * - always if saldo < reserva efectiva
 * - or early warning if saldo < reserva × (1 − umbral/100)
 */
export function hasDeficitRisk (
  availableBalance: number,
  effectiveReserve: number,
  deficitAlertThresholdPercent: number
): boolean {
  if (availableBalance < effectiveReserve) return true
  const pct = Math.max(0, deficitAlertThresholdPercent)
  const earlyLine = effectiveReserve * (1 - pct / 100)
  return availableBalance < earlyLine
}

export function buildInsights (params: {
  historySufficient: boolean
  availableBalance: number
  effectiveReserve: number
  idleCapital: number
  deficitAlertThresholdPercent: number
  minExpectedRoiPercent: number
}): FinanceInsight[] {
  const insights: FinanceInsight[] = []
  const {
    historySufficient,
    availableBalance,
    effectiveReserve,
    idleCapital,
    deficitAlertThresholdPercent,
    minExpectedRoiPercent
  } = params

  if (!historySufficient) {
    insights.push({
      type: 'alert',
      severity: 'warning',
      code: 'FINANCE_INSUFFICIENT_HISTORY',
      title: 'Ausencia de Datos Históricos Suficientes',
      explanation:
        'No hay registros suficientes en la ventana de evaluación histórica configurada para calcular con precisión estimaciones de ROI y proyección. Se deshabilitan las estimaciones de ROI.',
      rulesVersion: FINANCE_RULES_VERSION
    })
  }

  if (hasDeficitRisk(availableBalance, effectiveReserve, deficitAlertThresholdPercent)) {
    insights.push({
      type: 'alert',
      severity: 'critical',
      code: 'FINANCE_DEFICIT_RISK',
      title: 'Riesgo de Déficit Detectado',
      explanation:
        'El saldo actual no cubre la reserva mínima de seguridad (o cae bajo el umbral de alerta configurado). Priorizá liquidez y cobertura de egresos operativos.',
      rulesVersion: FINANCE_RULES_VERSION,
      disclaimer: DISCLAIMER_NO_ADVICE
    })
    insights.push({
      type: 'recommendation',
      severity: 'warning',
      code: 'FINANCE_REC_PRESERVE_LIQUIDITY',
      title: 'Mantener Liquidez',
      explanation:
        'Ante riesgo de déficit, el sistema prioriza preservar liquidez sobre sugerencias de inversión en stock u otras optimizaciones.',
      rulesVersion: FINANCE_RULES_VERSION,
      disclaimer: DISCLAIMER_NO_ADVICE
    })
  } else if (idleCapital > 0 && historySufficient) {
    insights.push({
      type: 'recommendation',
      severity: 'info',
      code: 'FINANCE_REC_REVIEW_IDLE_CAPITAL',
      title: 'Capital Ocioso Detectado',
      explanation:
        `Hay un excedente estimado de ARS ${idleCapital.toFixed(2)} sobre la reserva efectiva. ROI de referencia para análisis: ${minExpectedRoiPercent}%.`,
      rulesVersion: FINANCE_RULES_VERSION,
      disclaimer: DISCLAIMER_NO_ADVICE
    })
  }

  return insights
}

export function buildOpportunityCard (params: {
  historySufficient: boolean
  idleCapital: number
  deficitRisk: boolean
  minExpectedRoiPercent: number
}): FinanceOpportunityCard {
  const { historySufficient, idleCapital, deficitRisk, minExpectedRoiPercent } = params
  const roiEnabled = historySufficient && !deficitRisk && idleCapital > 0

  if (!roiEnabled) {
    return {
      code: 'CAPITAL_OCIOSO_NO_DETECTADO',
      title: deficitRisk ? 'Capital Ocioso No Detectado' : 'Capital Ocioso No Detectado',
      explanation: deficitRisk
        ? 'No hay capital ocioso disponible para sugerir inversión mientras exista riesgo de déficit o cobertura insuficiente de la reserva.'
        : !historySufficient
          ? 'Con historial insuficiente no se estiman oportunidades de capital ocioso ni ROI de referencia.'
          : 'El saldo disponible no supera la reserva efectiva configurada.',
      referenceRoiPercent: historySufficient ? minExpectedRoiPercent : null,
      idleCapital: 0,
      roiEnabled: false,
      disclaimer: DISCLAIMER_NO_ADVICE
    }
  }

  return {
    code: 'CAPITAL_OCIOSO_DETECTADO',
    title: 'Capital Ocioso Detectado',
    explanation:
      `Excedente estimado ARS ${idleCapital.toFixed(2)} sobre la reserva de seguridad. ROI de referencia (umbral de análisis): ${minExpectedRoiPercent}%. Revisá oportunidades operativas (p. ej. mercadería de alta rotación) sin ejecución automática.`,
    referenceRoiPercent: minExpectedRoiPercent,
    idleCapital,
    roiEnabled: true,
    disclaimer: DISCLAIMER_NO_ADVICE
  }
}

/** Start of ISO week (Monday UTC) containing `date`. */
export function startOfUtcWeek (date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = d.getUTCDay() || 7
  if (day !== 1) d.setUTCDate(d.getUTCDate() - (day - 1))
  d.setUTCHours(0, 0, 0, 0)
  return d
}

export function addUtcDays (date: Date, days: number): Date {
  const d = new Date(date.getTime())
  d.setUTCDate(d.getUTCDate() + days)
  return d
}
