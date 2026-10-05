import { Schema, model } from 'mongoose'
import { ROUTING_CONFIG_KEYS } from '../interfaces/routeOptimization.interface'
import type { RoutingConfig } from '../interfaces/routeOptimization.interface'

const routingConfigSchema = new Schema<RoutingConfig>(
  {
    key: { type: String, required: true, enum: Object.values(ROUTING_CONFIG_KEYS), default: ROUTING_CONFIG_KEYS.DEPOSITO_1, immutable: true },
    enabled: { type: Boolean, required: true, default: false },
    revision: { type: Number, required: true, default: 1, min: 1 },
    depot: {
      name: { type: String, required: true, trim: true },
      latitude: { type: Number, required: true },
      longitude: { type: Number, required: true }
    },
    fuelConsumptionLitersPer100Km: { type: Number, min: 0 },
    provider: { type: String, required: true, trim: true },
    algorithm: { type: String, required: true, trim: true }
  },
  { timestamps: true, versionKey: false }
)

routingConfigSchema.index({ key: 1 }, { unique: true, name: 'idx_unique_routing_config_key' })

const RoutingConfigModel = model<RoutingConfig>('routingConfig', routingConfigSchema)

export { routingConfigSchema }
export default RoutingConfigModel
