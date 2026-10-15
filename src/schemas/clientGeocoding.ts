import { z } from 'zod'
import {
  GEOCODING_PRECISION,
  GEOCODING_SOURCE,
  GEOCODING_STATUS
} from '../interfaces/client.interface'

const latitudeSchema = z.number().finite().min(-90).max(90)
const longitudeSchema = z.number().finite().min(-180).max(180)

const geocodingCandidateSchema = z.object({
  formattedAddress: z.string().trim().min(1).max(500),
  placeId: z.string().trim().min(1).max(500),
  precision: z.enum([
    GEOCODING_PRECISION.ROOFTOP,
    GEOCODING_PRECISION.RANGE_INTERPOLATED,
    GEOCODING_PRECISION.GEOMETRIC_CENTER,
    GEOCODING_PRECISION.APPROXIMATE
  ]),
  lat: latitudeSchema,
  lng: longitudeSchema
}).strict()

const geocodeRequestSchema = z.object({
  address: z.string().trim().min(1).max(500).optional()
}).strict()

const manualReferenceSchema = z.object({
  address: z.string().trim().min(1).max(500),
  lat: latitudeSchema.optional(),
  lng: longitudeSchema.optional()
}).strict().superRefine((reference, context) => {
  if ((reference.lat === undefined) !== (reference.lng === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Manual coordinates require both lat and lng',
      path: reference.lat === undefined ? ['lat'] : ['lng']
    })
  }
})

const clientLocationConfirmationSchema = z.union([
  z.object({ candidate: geocodingCandidateSchema }).strict(),
  z.object({ manualReference: manualReferenceSchema }).strict()
])

const clientGeocodingSchema = z.object({
  status: z.enum([
    GEOCODING_STATUS.UNVERIFIED,
    GEOCODING_STATUS.PENDING,
    GEOCODING_STATUS.CONFIRMED,
    GEOCODING_STATUS.AMBIGUOUS,
    GEOCODING_STATUS.INVALID
  ]),
  source: z.enum([
    GEOCODING_SOURCE.LEGACY,
    GEOCODING_SOURCE.GEOCODED,
    GEOCODING_SOURCE.MANUAL
  ]),
  formattedAddress: z.string().trim().min(1).max(500).optional(),
  placeId: z.string().trim().min(1).max(500).optional(),
  precision: z.enum([
    GEOCODING_PRECISION.ROOFTOP,
    GEOCODING_PRECISION.RANGE_INTERPOLATED,
    GEOCODING_PRECISION.GEOMETRIC_CENTER,
    GEOCODING_PRECISION.APPROXIMATE
  ]).optional(),
  validatedAt: z.date().optional(),
  validatedBy: z.string().trim().min(1).optional()
})

export {
  clientGeocodingSchema,
  clientLocationConfirmationSchema,
  geocodeRequestSchema,
  geocodingCandidateSchema,
  latitudeSchema,
  longitudeSchema
}
export type GeocodeRequest = z.infer<typeof geocodeRequestSchema>
export type GeocodingCandidate = z.infer<typeof geocodingCandidateSchema>
export type ClientLocationConfirmation = z.infer<typeof clientLocationConfirmationSchema>
