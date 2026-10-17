import { Schema, model } from 'mongoose'
import type { RoutePlan } from '../interfaces/routeOptimization.interface'

const routePlanStopSchema = new Schema(
  {
    clientId: { type: String, required: true, immutable: true },
    saleIds: { type: [String], required: true, immutable: true },
    sequence: { type: Number, required: true, immutable: true },
    latitude: { type: Number, required: true, immutable: true },
    longitude: { type: Number, required: true, immutable: true }
  },
  { _id: false }
)

const routePlanSegmentSchema = new Schema(
  {
    fromStopSequence: { type: Number, required: true, immutable: true },
    toStopSequence: { type: Number, required: true, immutable: true },
    distanceMeters: { type: Number, required: true, immutable: true },
    durationSeconds: { type: Number, required: true, immutable: true }
  },
  { _id: false }
)

const routePlanSchema = new Schema<RoutePlan>(
  {
    snapshotVersion: { type: Number, required: true, immutable: true },
    planningDate: { type: Date, required: true, immutable: true },
    zoneSnapshot: {
      code: { type: String, required: true, immutable: true },
      normalizedName: { type: String, required: true, immutable: true },
      name: { type: String, required: true, immutable: true }
    },
    selectedSaleIds: { type: [String], required: true, immutable: true },
    depot: {
      name: { type: String, required: true, immutable: true },
      latitude: { type: Number, required: true, immutable: true },
      longitude: { type: Number, required: true, immutable: true },
      address: { type: String, required: false, trim: true, immutable: true }
    },
    stops: { type: [routePlanStopSchema], required: true, immutable: true },
    segments: { type: [routePlanSegmentSchema], required: true, immutable: true },
    metrics: {
      distanceMeters: { type: Number, required: true, immutable: true },
      durationSeconds: { type: Number, required: true, immutable: true },
      stopCount: { type: Number, required: true, immutable: true },
      fuelLiters: { type: Number, required: false, default: null, immutable: true },
      availability: { type: String, required: false, immutable: true }
    },
    algorithm: {
      name: { type: String, required: true, immutable: true },
      version: { type: String, required: true, immutable: true },
      provider: { type: String, required: true, immutable: true }
    },
    routingConfigRevision: { type: Number, required: true, immutable: true },
    ruleVersion: { type: String, required: true, immutable: true },
    encodedPolyline: { type: String, required: true, immutable: true },
    warnings: { type: [String], required: true, immutable: true },
    audit: {
      createdBy: { type: String, required: true, immutable: true },
      createdAt: { type: Date, required: true, immutable: true }
    },
    assignments: {
      driverId: { type: String, required: false, immutable: true },
      vehicleId: { type: String, required: false, immutable: true }
    },
    fuelAssumptions: { type: Schema.Types.Mixed, required: false, immutable: true },
    scheduleAssumptions: { type: Schema.Types.Mixed, required: false, immutable: true },
    stopEstimates: { type: Schema.Types.Mixed, required: false, immutable: true },
    saleReferences: { type: Schema.Types.Mixed, required: false, immutable: true }
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false }
)

routePlanSchema.index({ 'zoneSnapshot.code': 1, planningDate: 1 }, { name: 'idx_route_plan_zone_date' })
routePlanSchema.index({ planningDate: 1, 'zoneSnapshot.code': 1, createdAt: -1, _id: -1 }, { name: 'idx_route_plan_dashboard_read' })
routePlanSchema.index({ createdAt: -1, _id: -1 }, { name: 'idx_route_plan_snapshot_list' })
routePlanSchema.index({ 'audit.createdBy': 1, createdAt: -1 }, { name: 'idx_route_plan_creator_date' })

routePlanSchema.pre('save', function () {
  if (!this.isNew) throw new Error('Route plans are append-only')
})

routePlanSchema.pre(['findOneAndUpdate', 'replaceOne', 'updateMany', 'updateOne'], function () {
  throw new Error('Route plans are append-only')
})

const RoutePlanModel = model<RoutePlan>('routePlan', routePlanSchema)

export { routePlanSchema }
export default RoutePlanModel
