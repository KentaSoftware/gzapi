import { Schema, model } from 'mongoose'

/**
 * CashflowConfig — singleton for opening balance + editable finance rule knobs (CU-012).
 * Formula version remains finance-rules-v1 in code; these fields only tune thresholds.
 */
interface ICashflowConfig {
  openingBalance: number
  /** Multiplier for reserve = avgMonthlyOutflows * this (default 1). */
  reserveMonthsMultiplier: number
  deficitAlertEnabled: boolean
  idleCapitalRecommendMin: number
}

const CashflowConfigSchema = new Schema<ICashflowConfig>(
  {
    openingBalance: {
      type: Number,
      required: true,
      default: 0
    },
    reserveMonthsMultiplier: {
      type: Number,
      required: true,
      default: 1,
      min: 0
    },
    deficitAlertEnabled: {
      type: Boolean,
      required: true,
      default: true
    },
    idleCapitalRecommendMin: {
      type: Number,
      required: true,
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
