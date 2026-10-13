import { Schema, model } from 'mongoose'
import type { Vehicle } from '../interfaces/vehicle.interface'

const vehicleMongooseSchema = new Schema<Vehicle>(
  {
    code: { type: String, required: true, unique: true, trim: true, uppercase: true },
    fuelConsumptionLitersPer100Km: { type: Number, required: true, min: 0.000001 },
    attributes: { type: Map, of: String, default: {} },
    active: { type: Boolean, required: true, default: true }
  },
  { timestamps: true, versionKey: false }
)

vehicleMongooseSchema.index({ code: 1 }, { unique: true, name: 'idx_unique_vehicle_code' })
vehicleMongooseSchema.index({ active: 1, code: 1 }, { name: 'idx_vehicle_active_code' })

const VehicleModel = model<Vehicle>('vehicle', vehicleMongooseSchema)

export { vehicleMongooseSchema }
export default VehicleModel
