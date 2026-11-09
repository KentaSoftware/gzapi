import { Schema, model, Types } from 'mongoose'
import type { RoutePlan, RoutePreviewRequest } from '../interfaces/routeOptimization.interface'

interface PreviewReceipt {
  _id: string
  actor: string
  tokenHash: string
  expiresAt: Date
  purgeAt: Date
  snapshotId: Types.ObjectId
  snapshot: RoutePlan
  input: RoutePreviewRequest
  claimId?: string
  claimUntil?: Date
}

const schema = new Schema<PreviewReceipt>({
  _id: { type: String, required: true },
  actor: { type: String, required: true },
  tokenHash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  purgeAt: { type: Date, required: true, expires: 0 },
  snapshotId: { type: Schema.Types.ObjectId, required: true },
  snapshot: { type: Schema.Types.Mixed, required: true },
  input: { type: Schema.Types.Mixed, required: true },
  claimId: { type: String },
  claimUntil: { type: Date }
}, { versionKey: false })

export default model<PreviewReceipt>('routePlanPreviewReceipt', schema)
