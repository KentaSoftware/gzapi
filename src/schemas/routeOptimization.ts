import { z } from 'zod'

const coordinateSchema = z.number().finite()

const routingDepotSchema = z.object({
  name: z.string().trim().min(1),
  latitude: coordinateSchema,
  longitude: coordinateSchema
})

const routePlanZoneSnapshotSchema = z.object({
  code: z.string().trim().min(1),
  normalizedName: z.string().trim().min(1),
  name: z.string().trim().min(1)
})

const routePlanStopSchema = z.object({
  saleId: z.string().trim().min(1),
  sequence: z.number().int().positive(),
  latitude: coordinateSchema,
  longitude: coordinateSchema
})

const routePlanSegmentSchema = z.object({
  fromStopSequence: z.number().int().nonnegative(),
  toStopSequence: z.number().int().positive(),
  distanceMeters: z.number().nonnegative(),
  durationSeconds: z.number().nonnegative()
})

const routePlanMetricsSchema = z.object({
  distanceMeters: z.number().nonnegative(),
  durationSeconds: z.number().nonnegative(),
  stopCount: z.number().int().nonnegative()
})

const routePlanAlgorithmSchema = z.object({
  name: z.string().trim().min(1),
  version: z.string().trim().min(1),
  provider: z.string().trim().min(1)
})

const routePlanAuditSchema = z.object({
  createdBy: z.string().trim().min(1),
  createdAt: z.date()
})

const routePlanSnapshotSchema = z.object({
  planningDate: z.date(),
  zoneSnapshot: routePlanZoneSnapshotSchema,
  selectedSaleIds: z.array(z.string().trim().min(1)).min(1),
  depot: routingDepotSchema,
  stops: z.array(routePlanStopSchema).min(1),
  segments: z.array(routePlanSegmentSchema),
  metrics: routePlanMetricsSchema,
  algorithm: routePlanAlgorithmSchema,
  routingConfigRevision: z.number().int().positive(),
  warnings: z.array(z.string()),
  audit: routePlanAuditSchema
})

export {
  routePlanAlgorithmSchema,
  routePlanAuditSchema,
  routePlanMetricsSchema,
  routePlanSegmentSchema,
  routePlanSnapshotSchema,
  routePlanStopSchema,
  routePlanZoneSnapshotSchema,
  routingDepotSchema
}
