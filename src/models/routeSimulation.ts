import { Schema, model } from 'mongoose'

const routeSimulationSchema = new Schema({
  routeId: { type: String, required: true, immutable: true },
  routeSnapshot: { type: Schema.Types.Mixed, required: false, immutable: true },
  routeMetrics: { type: Schema.Types.Mixed, required: true, immutable: true },
  parameters: { type: Schema.Types.Mixed, required: true, immutable: true },
  products: { type: [Schema.Types.Mixed], required: true, immutable: true },
  estimatedRevenue: { type: Number, required: true, immutable: true },
  operatingCost: { type: Number, required: true, immutable: true },
  grossMargin: { type: Number, required: true, immutable: true }
}, { timestamps: { createdAt: true, updatedAt: false }, versionKey: false })

routeSimulationSchema.pre('save', function () {
  if (!this.isNew) throw new Error('Route simulations are append-only')
})
routeSimulationSchema.pre(['findOneAndUpdate', 'replaceOne', 'updateMany', 'updateOne'], function () {
  throw new Error('Route simulations are append-only')
})

export default model('routeSimulation', routeSimulationSchema)
