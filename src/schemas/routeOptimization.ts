import { z } from 'zod'
import {
  ROUTE_METRIC_AVAILABILITY,
  ROUTE_MODES,
  ROUTE_OPERATIONAL_STATUS,
  ROUTE_SNAPSHOT_STALENESS_CAUSE
} from '../interfaces/routeOptimization.interface'
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

const dashboardQuerySchema = z.object({
  serviceDate: z.string().refine(isCivilDate, 'serviceDate must be a civil date').optional(),
  zoneCode: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'zoneCode is invalid').optional(),
  status: z.enum(Object.values(ROUTE_OPERATIONAL_STATUS) as [string, ...string[]]).optional()
}).strict().superRefine((input, context) => {
  if ((input.serviceDate === undefined) !== (input.zoneCode === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'serviceDate and zoneCode must be provided together' })
  }
})

const routePreviewRequestSchema = candidateQuerySchema.extend({
  saleIds: z.array(z.string().trim().regex(/^[a-fA-F0-9]{24}$/, 'saleIds must contain ObjectIds')).min(1),
  driverId: z.string().trim().min(1).optional(),
  vehicleId: z.string().trim().min(1).optional()
}).superRefine((input, context) => {
  if (new Set(input.saleIds).size !== input.saleIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'saleIds must not contain duplicates', path: ['saleIds'] })
  }
  if (input.driverId === undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: 'driverId is required before preview or save', path: ['driverId'] })
  if (input.vehicleId === undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: 'vehicleId is required before preview or save', path: ['vehicleId'] })
})

const coordinateSchema = z.number().finite()
const latitudeSchema = z.number().finite().min(-90).max(90)
const longitudeSchema = z.number().finite().min(-180).max(180)

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
  name: z.string().trim().min(1).max(200),
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  address: z.string().trim().min(1).max(500).optional()
}).strict()

const routingConfigUpdateSchema = z.object({
  depot: routingDepotSchema,
  fuelConsumptionLitersPer100Km: z.number().finite().min(0).optional(),
  routeMode: z.enum([ROUTE_MODES.GOOGLE_ROUTES]),
  algorithm: z.string().trim().min(1).max(100).optional(),
  maxStops: z.number().int().positive().optional(),
  enabled: z.boolean().optional()
}).strict()

const deliveryZoneCreateSchema = z.object({
  code: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(1).max(120),
  active: z.boolean().optional()
}).strict()

const deliveryZoneUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  active: z.boolean().optional()
}).strict().refine((input) => input.name !== undefined || input.active !== undefined, {
  message: 'At least one delivery zone field is required'
})

const deliveryZoneQuerySchema = z.object({
  active: z.enum(['true', 'false']).optional()
}).strict()

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

const routeMetricAvailabilitySchema = z.enum(Object.values(ROUTE_METRIC_AVAILABILITY) as [string, ...string[]])

const routePlanMetricsSchema = z.object({
  distanceMeters: z.number().nonnegative(),
  durationSeconds: z.number().nonnegative(),
  stopCount: z.number().int().nonnegative(),
  fuelLiters: z.number().nonnegative().nullable().default(null),
  availability: routeMetricAvailabilitySchema.optional()
})

const routeOperationalStatusSchema = z.enum(Object.values(ROUTE_OPERATIONAL_STATUS) as [string, ...string[]])
const routeSnapshotStalenessCauseSchema = z.enum(Object.values(ROUTE_SNAPSHOT_STALENESS_CAUSE) as [string, ...string[]])

const routeFuelAssumptionsSchema = z.object({
  availability: routeMetricAvailabilitySchema,
  consumptionLitersPer100Km: z.number().finite().nonnegative().nullable(),
  distanceKm: z.number().finite().nonnegative(),
  vehicleCode: z.string().trim().min(1).nullable(),
  source: z.string().trim().min(1),
  calculatedAt: z.date()
}).strict()

const routeScheduleAssumptionsSchema = z.object({
  calculatedAt: z.date(),
  timezone: z.string().trim().min(1),
  source: z.string().trim().min(1)
}).strict()

const routeStopEstimateSchema = z.object({
  sequence: z.number().int().positive(),
  arrival: z.date().nullable(),
  cumulativeDurationSeconds: z.number().finite().nonnegative().nullable(),
  calculatedAt: z.date(),
  timezone: z.string().trim().min(1),
  availability: routeMetricAvailabilitySchema
}).strict()

const routeOperationalAssignmentSchema = z.object({
  driverId: z.string().trim().min(1).optional(),
  vehicleId: z.string().trim().min(1).optional()
}).strict()

const routeOperationalUpdateSchema = z.object({
  version: z.number().int().positive(),
  driverId: z.string().trim().min(1),
  vehicleId: z.string().trim().min(1)
}).strict()

const routeOperationalHistoryEntrySchema = z.object({
  status: routeOperationalStatusSchema,
  driverId: z.string().trim().min(1).optional(),
  vehicleId: z.string().trim().min(1).optional(),
  changedBy: z.string().trim().min(1),
  changedAt: z.date(),
  version: z.number().int().positive()
}).strict()

const routePlanOperationalSchema = z.object({
  snapshotId: z.string().trim().min(1),
  status: routeOperationalStatusSchema,
  sourceDeliveryVersion: z.number().int().nonnegative(),
  assignments: routeOperationalAssignmentSchema,
  history: z.array(routeOperationalHistoryEntrySchema),
  version: z.number().int().positive(),
  updatedBy: z.string().trim().min(1).optional(),
  updatedAt: z.date().optional(),
  stale: z.boolean().optional(),
  staleCauses: z.array(routeSnapshotStalenessCauseSchema).optional(),
  staleDetectedAt: z.date().optional()
}).strict()

const selectableVehicleSchema = z.object({
  id: z.string().trim().min(1),
  code: z.string().trim().min(1),
  fuelConsumptionLitersPer100Km: z.number().finite().positive(),
  attributes: z.record(z.string(), z.string()),
  availability: z.boolean()
}).strict()

const routeSnapshotSaleReferenceSchema = z.object({
  saleId: z.string().trim().min(1),
  versionAtSave: z.number().int().nonnegative().nullable(),
  statusAtSave: z.enum([SALE_DELIVERY_STATUS.PENDING, SALE_DELIVERY_STATUS.DELIVERED]).nullable()
}).strict()

const routeSnapshotSaleRefSchema = z.object({
  saleId: z.string().trim().min(1),
  versionAtSave: z.number().int().nonnegative().nullable(),
  currentVersion: z.number().int().nonnegative().nullable(),
  currentStatus: z.enum([SALE_DELIVERY_STATUS.PENDING, SALE_DELIVERY_STATUS.DELIVERED]).nullable()
}).strict()

const routeSnapshotStalenessSchema = z.object({
  snapshotId: z.string().trim().min(1),
  stale: z.boolean(),
  causes: z.array(routeSnapshotStalenessCauseSchema),
  saleRefs: z.array(routeSnapshotSaleRefSchema),
  detectedAt: z.date()
}).strict()

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
  audit: routePlanAuditSchema,
  assignments: routeOperationalAssignmentSchema.optional(),
  fuelAssumptions: routeFuelAssumptionsSchema.optional(),
  scheduleAssumptions: routeScheduleAssumptionsSchema.optional(),
  stopEstimates: z.array(routeStopEstimateSchema).optional(),
  saleReferences: z.array(routeSnapshotSaleReferenceSchema).optional()
})

export {
  candidateQuerySchema,
  dashboardQuerySchema,
  deliveryZoneCreateSchema,
  deliveryZoneQuerySchema,
  deliveryZoneUpdateSchema,
  routePreviewRequestSchema,
  routePlanAlgorithmSchema,
  routePlanAuditSchema,
  routePlanMetricsSchema,
  routePlanSegmentSchema,
  routePlanSnapshotSchema,
  routePlanStopSchema,
  routePlanZoneSnapshotSchema,
  routeFuelAssumptionsSchema,
  routeMetricAvailabilitySchema,
  routeOperationalStatusSchema,
  routeOperationalUpdateSchema,
  routePlanOperationalSchema,
  routeScheduleAssumptionsSchema,
  routeSnapshotStalenessSchema,
  routeStopEstimateSchema,
  selectableVehicleSchema,
  routingConfigUpdateSchema,
  routingDepotSchema,
  saleDeliverySchema
}
