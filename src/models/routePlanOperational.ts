import { model, Schema } from 'mongoose'
import {
  ROUTE_OPERATIONAL_STATUS,
  ROUTE_SNAPSHOT_STALENESS_CAUSE
} from '../interfaces/routeOptimization.interface'
import type {
  RouteOperationalAssignment,
  RouteOperationalHistoryEntry,
  RoutePlanOperational
} from '../interfaces/routeOptimization.interface'

const routeOperationalAssignmentSchema = new Schema<RouteOperationalAssignment>(
  {
    driverId: { type: String, ref: 'user' },
    vehicleId: { type: String, ref: 'vehicle' }
  },
  { _id: false }
)

const routeOperationalHistoryEntrySchema = new Schema<RouteOperationalHistoryEntry>(
  {
    status: {
      type: String,
      required: true,
      enum: Object.values(ROUTE_OPERATIONAL_STATUS),
      immutable: true
    },
    driverId: { type: String, ref: 'user', immutable: true },
    vehicleId: { type: String, ref: 'vehicle', immutable: true },
    changedBy: { type: String, required: true, immutable: true },
    changedAt: { type: Date, required: true, immutable: true },
    version: { type: Number, required: true, min: 1, immutable: true }
  },
  { _id: false }
)

const routePlanOperationalSchema = new Schema<RoutePlanOperational>(
  {
    snapshotId: { type: String, required: true, immutable: true },
    status: {
      type: String,
      required: true,
      enum: Object.values(ROUTE_OPERATIONAL_STATUS)
    },
    sourceDeliveryVersion: { type: Number, required: true, min: 0 },
    assignments: { type: routeOperationalAssignmentSchema, required: true, default: {} },
    history: { type: [routeOperationalHistoryEntrySchema], required: true, default: [] },
    version: { type: Number, required: true, min: 1, default: 1 },
    updatedBy: { type: String },
    stale: { type: Boolean, default: false },
    staleCauses: {
      type: [String],
      enum: Object.values(ROUTE_SNAPSHOT_STALENESS_CAUSE)
    },
    staleDetectedAt: { type: Date }
  },
  { timestamps: true, versionKey: false }
)

routePlanOperationalSchema.index({ snapshotId: 1 }, { unique: true, name: 'idx_unique_route_plan_operational_snapshot' })

const RoutePlanOperationalModel = model<RoutePlanOperational>('routePlanOperational', routePlanOperationalSchema)

export { routePlanOperationalSchema }
export default RoutePlanOperationalModel
