import { z } from 'zod'
import { SALE_DELIVERY_STATUS } from '../interfaces/sale.interface'

const isCivilDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

const candidateQuerySchema = z.object({
  serviceDate: z.string().refine(isCivilDate, 'serviceDate must be a civil date'),
  deliveryZoneId: z.string().trim().regex(/^[a-fA-F0-9]{24}$/, 'deliveryZoneId must be an ObjectId')
}).strict()

const routePreviewRequestSchema = candidateQuerySchema.extend({
  saleIds: z.array(z.string().trim().regex(/^[a-fA-F0-9]{24}$/, 'saleIds must contain ObjectIds')).min(1)
}).superRefine((input, context) => {
  if (new Set(input.saleIds).size !== input.saleIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'saleIds must not contain duplicates', path: ['saleIds'] })
  }
})

const coordinateSchema = z.number().finite()

const saleDeliverySchema = z.object({
  status: z.enum([SALE_DELIVERY_STATUS.PENDING, SALE_DELIVERY_STATUS.DELIVERED]),
  serviceDate: z.date().optional(),
  deliveredAt: z.date().optional(),
  notes: z.string().trim().optional()
}).superRefine((delivery, context) => {
  if (delivery.status === SALE_DELIVERY_STATUS.PENDING && delivery.serviceDate === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'PENDING delivery requires serviceDate',
      path: ['serviceDate']
    })
  }

  if (delivery.status === SALE_DELIVERY_STATUS.DELIVERED && delivery.deliveredAt === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'DELIVERED delivery requires deliveredAt',
      path: ['deliveredAt']
    })
  }
})

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

const groupedRoutePlanStopSchema = z.object({
  clientId: z.string().trim().min(1),
  saleIds: z.array(z.string().trim().min(1)).min(1),
  sequence: z.number().int().positive(),
  latitude: coordinateSchema,
  longitude: coordinateSchema
})

const routePlanStopSchema = z.union([
  groupedRoutePlanStopSchema,
  z.object({
    saleId: z.string().trim().min(1),
    sequence: z.number().int().positive(),
    latitude: coordinateSchema,
    longitude: coordinateSchema
  }).transform(({ saleId, sequence, latitude, longitude }) => ({
    clientId: saleId,
    saleIds: [saleId],
    sequence,
    latitude,
    longitude
  }))
])

const routePlanSegmentSchema = z.object({
  fromStopSequence: z.number().int().nonnegative(),
  toStopSequence: z.number().int().nonnegative(),
  distanceMeters: z.number().nonnegative(),
  durationSeconds: z.number().nonnegative()
})

const routePlanMetricsSchema = z.object({
  distanceMeters: z.number().nonnegative(),
  durationSeconds: z.number().nonnegative(),
  stopCount: z.number().int().nonnegative(),
  fuelLiters: z.number().nonnegative().default(0)
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
  snapshotVersion: z.number().int().positive().default(1),
  planningDate: z.date(),
  zoneSnapshot: routePlanZoneSnapshotSchema,
  selectedSaleIds: z.array(z.string().trim().min(1)).min(1),
  depot: routingDepotSchema,
  stops: z.array(routePlanStopSchema).min(1),
  segments: z.array(routePlanSegmentSchema),
  metrics: routePlanMetricsSchema,
  algorithm: routePlanAlgorithmSchema,
  routingConfigRevision: z.number().int().positive(),
  ruleVersion: z.string().trim().min(1).default('candidate-eligibility-v1'),
  encodedPolyline: z.string().default(''),
  warnings: z.array(z.string()),
  audit: routePlanAuditSchema
})

export {
  candidateQuerySchema,
  routePreviewRequestSchema,
  routePlanAlgorithmSchema,
  routePlanAuditSchema,
  routePlanMetricsSchema,
  routePlanSegmentSchema,
  routePlanSnapshotSchema,
  routePlanStopSchema,
  routePlanZoneSnapshotSchema,
  routingDepotSchema,
  saleDeliverySchema
}
