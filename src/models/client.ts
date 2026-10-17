import { Schema, model } from 'mongoose'
import {
  Client,
  GEOCODING_PRECISION,
  GEOCODING_SOURCE,
  GEOCODING_STATUS
} from '../interfaces/client.interface'

const geocodingSchema = new Schema(
  {
    status: { type: String, required: true, enum: Object.values(GEOCODING_STATUS) },
    source: { type: String, required: true, enum: Object.values(GEOCODING_SOURCE) },
    formattedAddress: { type: String, trim: true },
    placeId: { type: String, trim: true },
    precision: { type: String, enum: Object.values(GEOCODING_PRECISION) },
    validatedAt: { type: Date },
    validatedBy: { type: Schema.Types.ObjectId, ref: 'user' }
  },
  { _id: false }
)

const ClientSchema = new Schema<Client>(
  {
    nombreCompleto: {
      type: String,
      require: true
    },
    address: {
      type: String,
      trim: true
    },
    telefonos: {
      type: [
        Number
      ]
    },
    lat: {
      type: Number,
      min: -90,
      max: 90
    },
    lng: {
      type: Number,
      min: -180,
      max: 180
    },
    deliveryZoneId: { type: Schema.Types.ObjectId, ref: 'deliveryZone' },
    isActive: { type: Boolean },
    geocoding: { type: geocodingSchema }
  },
  {
    timestamps: true,
    versionKey: false
  }
)

ClientSchema.pre('validate', function (next) {
  const client = this as Client
  const hasLat = client.lat !== undefined
  const hasLng = client.lng !== undefined

  if (hasLat !== hasLng) {
    this.invalidate('lat', 'lat and lng must be present together')
  }

  const geocoding = client.geocoding
  if (geocoding?.status === GEOCODING_STATUS.CONFIRMED && (!hasLat || !hasLng || geocoding.validatedAt === undefined || geocoding.validatedBy === undefined)) {
    this.invalidate('geocoding.status', 'Confirmed geocoding requires coordinates, validatedAt, and validatedBy')
  }

  if (geocoding?.source === GEOCODING_SOURCE.MANUAL && geocoding.validatedBy === undefined) {
    this.invalidate('geocoding.source', 'Manual geocoding requires validatedBy')
  }

  next()
})

const ClientModel = model('client', ClientSchema)
export default ClientModel
