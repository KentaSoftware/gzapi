import { Schema, model } from 'mongoose'

/**
 * CashflowConfig — singleton document that stores the opening balance.
 * Only one record is expected per deployment (upserted by CashflowService on first access).
 * TICKET-002: cash-flow-real-v1
 */
interface ICashflowConfig {
  openingBalance: number
}

const CashflowConfigSchema = new Schema<ICashflowConfig>(
  {
    openingBalance: {
      type: Number,
      required: true,
      default: 0
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
)

const CashflowConfigModel = model<ICashflowConfig>('cashflowConfig', CashflowConfigSchema)
export default CashflowConfigModel
