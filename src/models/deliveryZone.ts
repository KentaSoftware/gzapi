import { Schema, model } from 'mongoose'
import type { DeliveryZone } from '../interfaces/routeOptimization.interface'

const deliveryZoneSchema = new Schema<DeliveryZone>(
  {
    code: { type: String, required: true, trim: true, uppercase: true },
    normalizedName: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    active: { type: Boolean, required: true, default: true }
  },
  { timestamps: true, versionKey: false }
)

deliveryZoneSchema.index({ code: 1 }, { unique: true, name: 'idx_unique_delivery_zone_code' })
deliveryZoneSchema.index({ normalizedName: 1 }, { unique: true, name: 'idx_unique_delivery_zone_normalized_name' })

const DeliveryZoneModel = model<DeliveryZone>('deliveryZone', deliveryZoneSchema)

export { deliveryZoneSchema }
export default DeliveryZoneModel
