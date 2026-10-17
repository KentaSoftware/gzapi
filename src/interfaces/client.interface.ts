import { Types } from 'mongoose'

export interface City {
  _id: Types.ObjectId
  descripcion: string
}

export const GEOCODING_STATUS = {
  UNVERIFIED: 'UNVERIFIED',
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  AMBIGUOUS: 'AMBIGUOUS',
  INVALID: 'INVALID'
} as const

export const GEOCODING_SOURCE = {
  LEGACY: 'LEGACY',
  GEOCODED: 'GEOCODED',
  MANUAL: 'MANUAL'
} as const

export const GEOCODING_PRECISION = {
  ROOFTOP: 'ROOFTOP',
  RANGE_INTERPOLATED: 'RANGE_INTERPOLATED',
  GEOMETRIC_CENTER: 'GEOMETRIC_CENTER',
  APPROXIMATE: 'APPROXIMATE'
} as const

export type GeocodingStatus = (typeof GEOCODING_STATUS)[keyof typeof GEOCODING_STATUS]
export type GeocodingSource = (typeof GEOCODING_SOURCE)[keyof typeof GEOCODING_SOURCE]
export type GeocodingPrecision = (typeof GEOCODING_PRECISION)[keyof typeof GEOCODING_PRECISION]

export interface ClientGeocoding {
  status: GeocodingStatus
  source: GeocodingSource
  formattedAddress?: string
  placeId?: string
  precision?: GeocodingPrecision
  validatedAt?: Date
  validatedBy?: Types.ObjectId
}

export interface Client {
  _id: Types.ObjectId
  nombreCompleto: string
  idCiudad?: Types.ObjectId
  telefonos?: number[]
  lat?: number
  lng?: number
  address?: string
  deliveryZoneId?: Types.ObjectId
  isActive?: boolean
  geocoding?: ClientGeocoding
}
