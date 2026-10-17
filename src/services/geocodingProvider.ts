import axios from 'axios'
import { GEOCODING_PRECISION } from '../interfaces/client.interface'
import type { GeocodingCandidate } from '../schemas/clientGeocoding'

interface GoogleGeocodingResult {
  formatted_address?: unknown
  place_id?: unknown
  geometry?: {
    location?: {
      lat?: unknown
      lng?: unknown
    }
    location_type?: unknown
  }
}

interface GoogleGeocodingResponse {
  status?: unknown
  results?: unknown
}

class GeocodingProviderUnavailableError extends Error {
  constructor () {
    super('Geocoding provider is unavailable')
    this.name = 'GeocodingProviderUnavailableError'
  }
}

const precisionFromGoogle = (value: unknown): GeocodingCandidate['precision'] => {
  if (value === GEOCODING_PRECISION.ROOFTOP) return GEOCODING_PRECISION.ROOFTOP
  if (value === GEOCODING_PRECISION.RANGE_INTERPOLATED) return GEOCODING_PRECISION.RANGE_INTERPOLATED
  if (value === GEOCODING_PRECISION.GEOMETRIC_CENTER) return GEOCODING_PRECISION.GEOMETRIC_CENTER
  return GEOCODING_PRECISION.APPROXIMATE
}

const normalizeCandidate = (result: GoogleGeocodingResult): GeocodingCandidate | undefined => {
  const formattedAddress = result.formatted_address
  const placeId = result.place_id
  const lat = result.geometry?.location?.lat
  const lng = result.geometry?.location?.lng

  if (typeof formattedAddress !== 'string' || typeof placeId !== 'string' || typeof lat !== 'number' || typeof lng !== 'number') {
    return undefined
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return undefined
  }

  return {
    formattedAddress,
    placeId,
    precision: precisionFromGoogle(result.geometry?.location_type),
    lat,
    lng
  }
}

const geocode = async ({ address }: { address: string }): Promise<GeocodingCandidate[]> => {
  const apiKey = process.env.GOOGLE_MAPS_SERVER_API_KEY
  if (apiKey === undefined || apiKey === '') throw new GeocodingProviderUnavailableError()

  let response: { data: GoogleGeocodingResponse }
  try {
    response = await axios.get<GoogleGeocodingResponse>('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { address, key: apiKey },
      timeout: 5000
    })
  } catch {
    throw new GeocodingProviderUnavailableError()
  }

  if (response.data.status === 'ZERO_RESULTS') return []
  if (response.data.status !== 'OK' || !Array.isArray(response.data.results)) {
    throw new GeocodingProviderUnavailableError()
  }

  return response.data.results
    .filter((result): result is GoogleGeocodingResult => typeof result === 'object' && result !== null)
    .map(normalizeCandidate)
    .filter((candidate): candidate is GeocodingCandidate => candidate !== undefined)
}

export { GeocodingProviderUnavailableError, geocode }
