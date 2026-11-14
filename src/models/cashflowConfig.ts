import { Schema, model } from 'mongoose'

export type FinanceRiskProfile = 'conservador' | 'moderado' | 'agresivo'

/**
 * CashflowConfig — singleton.
 * - openingBalance: used by /cashflow and as baseline for Finanzas Saldo Actual (not shown in /finance rules UI).
 * - CUR-6 knobs: reserve/deficit/ROI/history/risk (avance 2).
 */
interface ICashflowConfig {
  openingBalance: number
  reserveMinimumAmount: number
  deficitAlertThresholdPercent: number
  minExpectedRoiPercent: number
  historyEvaluationDays: number
  riskProfile: FinanceRiskProfile
  /** @deprecated avance-1 Spec knobs — kept for backward-compatible documents */
  reserveMonthsMultiplier?: number
  deficitAlertEnabled?: boolean
  idleCapitalRecommendMin?: number
}

const CashflowConfigSchema = new Schema<ICashflowConfig>(
  {
    openingBalance: {
      type: Number,
      required: true,
      default: 0
    },
    reserveMinimumAmount: {
      type: Number,
      required: true,
      default: 500000,
      min: 0
    },
    deficitAlertThresholdPercent: {
      type: Number,
      required: true,
      default: 20,
      min: 0
    },
    minExpectedRoiPercent: {
      type: Number,
      required: true,
      default: 18,
      min: 0
    },
    historyEvaluationDays: {
      type: Number,
      required: true,
      default: 90,
      min: 1
    },
    riskProfile: {
      type: String,
      enum: ['conservador', 'moderado', 'agresivo'],
      required: true,
      default: 'moderado'
    },
    reserveMonthsMultiplier: {
      type: Number,
      required: false,
      default: 1,
      min: 0
    },
    deficitAlertEnabled: {
      type: Boolean,
      required: false,
      default: true
    },
    idleCapitalRecommendMin: {
      type: Number,
      required: false,
      default: 0,
      min: 0
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
)

const CashflowConfigModel = model<ICashflowConfig>('cashflowConfig', CashflowConfigSchema)
export default CashflowConfigModel
