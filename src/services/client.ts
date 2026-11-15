import { Types } from 'mongoose'
import { isDeepStrictEqual } from 'node:util'
import ClientModel from '../models/client'
import DeliveryZoneModel from '../models/deliveryZone'
import { Client, GEOCODING_SOURCE, GEOCODING_STATUS } from '../interfaces/client.interface'
import type { ClientLocationConfirmation, GeocodingCandidate } from '../schemas/clientGeocoding'
import { expectedLocationSchema } from '../schemas/clientGeocoding'
import { geocode } from './geocodingProvider'

class ClientNotFoundError extends Error {
  constructor () {
    super('Client was not found')
    this.name = 'ClientNotFoundError'
  }
}

class ClientLocationConflictError extends Error {
  constructor () {
    super('Client location changed; reload and review it again')
    this.name = 'ClientLocationConflictError'
  }
}

class ClientLocationInputError extends Error {
  constructor () {
    super('Geocoding metadata cannot be supplied through client creation')
    this.name = 'ClientLocationInputError'
  }
}

class ClientInputError extends Error {}
class ClientEditConflictError extends Error {
  constructor () {
    super('Client data changed; reload and review it again')
  }
}

const matchesContactField = (key: string, actual: unknown, expected: unknown): boolean => {
  if (expected === null) return actual == null
  if (key === 'deliveryZoneId') return actual != null && String(actual) === expected
  return isDeepStrictEqual(actual, expected)
}

const validateCoordinates = (lat: unknown, lng: unknown): void => {
  if (lat == null && lng == null) return
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
      typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new ClientInputError('Coordinates must be a valid latitude and longitude pair, or both empty')
  }
}

const validateClientFields = async (item: Record<string, unknown>, create: boolean): Promise<void> => {
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(item, key)
  if ((create || has('nombreCompleto')) && (typeof item.nombreCompleto !== 'string' || item.nombreCompleto.trim() === '' || item.nombreCompleto.length > 200)) {
    throw new ClientInputError('Client name must be a nonblank string of at most 200 characters')
  }
  if (has('telefonos') && (!Array.isArray(item.telefonos) || item.telefonos.some((phone: unknown) => {
    if (typeof phone !== 'number' && (typeof phone !== 'string' || !/^\d{1,15}$/.test(phone))) return true
    const number = Number(phone)
    return !Number.isSafeInteger(number) || number < 0 || number > 999999999999999
  }))) throw new ClientInputError('Phone numbers must be nonnegative integers of at most 15 digits')
  if (has('isActive') && typeof item.isActive !== 'boolean') throw new ClientInputError('Client status must be a boolean')
  if (Object.keys(item).some((key) => /^(nombreCompleto|telefonos|deliveryZoneId|isActive|lat|lng)\./.test(key))) throw new ClientInputError('Client fields must not use dotted paths')
  if (has('deliveryZoneId') && item.deliveryZoneId !== null) {
    if (typeof item.deliveryZoneId !== 'string' || !/^[a-fA-F0-9]{24}$/.test(item.deliveryZoneId)) throw new ClientInputError('Delivery zone is invalid')
    if (await DeliveryZoneModel.exists({ _id: new Types.ObjectId(item.deliveryZoneId), active: true }) === null) throw new ClientInputError('Delivery zone must be active')
  }
}

const containsGeocodingKey = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false
  return Object.entries(value).some(([key, nested]) => key === 'geocoding' || key.startsWith('geocoding.') || key === 'locationRevision' || key.startsWith('locationRevision.') || containsGeocodingKey(nested))
}

const insertClient = async (item: Client): Promise<Client> => {
  if (containsGeocodingKey(item)) throw new ClientLocationInputError()
  if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new ClientInputError('Client input is invalid')
  await validateClientFields(item as unknown as Record<string, unknown>, true)
  validateCoordinates(item.lat, item.lng)
  const { address, ...rest } = item
  const responseInsert = await ClientModel.create({ ...rest, ...(address == null ? {} : { address }), isActive: item.isActive ?? true })
  return responseInsert
}

const getClients = async (skip: number, limit: number): Promise<Client[]> => {
  const response = await ClientModel.aggregate([
    {
      $project: {
        nombreCompleto: 1,
        address: 1,
        lat: 1,
        lng: 1,
        telefonos: 1,
        isActive: 1,
        deliveryZoneId: 1,
        locationRevision: { $ifNull: ['$locationRevision', 0] }
      }
    },
    { $sort: { nombreCompleto: 1, _id: 1 } }
  ])
    .skip(skip)
    .limit(limit)
  return response
}

const getClientSearch = async (input: string, skip?: number, limit?: number): Promise<Client[]> => {
  const query: any = {
  }

  if (input !== '') {
    query.nombreCompleto = {
      $regex: input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      $options: 'i'
    }
  }

  const aggregation = ClientModel.aggregate([
    { $match: query },
    {
      $project: {
        nombreCompleto: 1,
        address: 1,
        lat: 1,
        lng: 1,
        telefonos: 1,
        isActive: 1,
        deliveryZoneId: 1,
        locationRevision: { $ifNull: ['$locationRevision', 0] }
      }
    },
    { $sort: { nombreCompleto: 1, _id: 1 } }
  ])
  if (skip !== undefined && limit !== undefined) void aggregation.skip(skip).limit(limit)
  return await aggregation
}

interface SaleClientOption {
  id: string
  name: string
  address?: string
  deliveryZoneName: string | null
}

const getSaleClientZoneNames = async (clients: Array<{ deliveryZoneId?: Types.ObjectId | null }>): Promise<Map<string, string>> => {
  const ids = new Map<string, Types.ObjectId>()
  for (const client of clients) {
    if (client.deliveryZoneId != null) ids.set(String(client.deliveryZoneId), client.deliveryZoneId)
  }
  if (ids.size === 0) return new Map()
  const zones = await DeliveryZoneModel.find({ _id: { $in: [...ids.values()] } }, { _id: 1, name: 1 }).maxTimeMS(5000).lean()
  return new Map(zones.filter(zone => typeof zone.name === 'string').map(zone => [String(zone._id), zone.name]))
}

const getSaleClientOptions = async (input: string): Promise<SaleClientOption[]> => {
  const literal = input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const clients = await ClientModel.find(
    { isActive: true, nombreCompleto: new RegExp(`^${literal}`, 'i') },
    { _id: 1, nombreCompleto: 1, address: 1, deliveryZoneId: 1 }
  ).sort({ nombreCompleto: 1, _id: 1 }).limit(20).maxTimeMS(5000).lean()
  const zoneNames = await getSaleClientZoneNames(clients)
  return clients.map((client) => ({
    id: String(client._id),
    name: client.nombreCompleto,
    ...(typeof client.address === 'string' ? { address: client.address } : {}),
    deliveryZoneName: client.deliveryZoneId == null ? null : zoneNames.get(String(client.deliveryZoneId)) ?? null
  }))
}

interface SaleClientCursor {
  id: string
  query: string
}

const getSaleClientOptionsPage = async (input: string, limit: number, cursor?: SaleClientCursor): Promise<{ clients: SaleClientOption[], nextCursor: string | null }> => {
  const literal = input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const clients = await ClientModel.find(
    {
      isActive: true,
      ...(input === '' ? {} : { nombreCompleto: new RegExp(`^${literal}`, 'i') }),
      ...(cursor === undefined ? {} : { _id: { $gt: new Types.ObjectId(cursor.id) } })
    },
    { _id: 1, nombreCompleto: 1, address: 1, deliveryZoneId: 1 }
  ).sort({ _id: 1 }).limit(limit + 1).maxTimeMS(5000).lean()
  const page = clients.slice(0, limit)
  const zoneNames = await getSaleClientZoneNames(page)
  const last = page[page.length - 1]
  const nextCursor = clients.length > limit
    ? Buffer.from(JSON.stringify({ id: String(last._id), query: input })).toString('base64url')
    : null
  return {
    clients: page.map((client) => ({
      id: String(client._id),
      name: typeof client.nombreCompleto === 'string' && client.nombreCompleto.trim() !== '' ? client.nombreCompleto : 'Sin nombre',
      ...(typeof client.address === 'string' ? { address: client.address } : {}),
      deliveryZoneName: client.deliveryZoneId == null ? null : zoneNames.get(String(client.deliveryZoneId)) ?? null
    })),
    nextCursor
  }
}

const getClient = async (id: Types.ObjectId): Promise<any> => {
  const response = await ClientModel.aggregate([
    { $match: { _id: { $eq: id } } },
    {
      $project: {
        nombreCompleto: 1,
        address: 1,
        lat: 1,
        lng: 1,
        telefonos: 1,
        isActive: 1,
        deliveryZoneId: 1,
        locationRevision: { $ifNull: ['$locationRevision', 0] }
      }
    }
  ])
  return response?.[0]
}

const updateClient = async (id: Types.ObjectId, item: Client, managed = false): Promise<any> => {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new ClientInputError('Client input is invalid')
  const record = item as unknown as Record<string, unknown>
  const fields = Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'expectedLocation' && key !== 'expectedFields' && key !== 'geocoding' && !key.startsWith('geocoding.') && key !== 'locationRevision' && !key.startsWith('locationRevision.') && !key.startsWith('$')))
  if (managed && Object.keys(fields).some((key) => !['nombreCompleto', 'telefonos', 'deliveryZoneId', 'isActive', 'address', 'lat', 'lng'].includes(key))) throw new ClientInputError('Client field is invalid')
  await validateClientFields(fields, false)
  const expectedFields = record.expectedFields
  const contactKeys = ['nombreCompleto', 'telefonos', 'deliveryZoneId', 'isActive']
  const contactFilter: Record<string, unknown> = {}
  if (managed) {
    if (typeof expectedFields !== 'object' || expectedFields === null || Array.isArray(expectedFields)) throw new ClientInputError('Expected client fields are required')
    const expected = expectedFields as Record<string, unknown>
    const changed = contactKeys.filter((key) => Object.prototype.hasOwnProperty.call(fields, key))
    if (Object.keys(expected).some((key) => !changed.includes(key)) || changed.some((key) => !Object.prototype.hasOwnProperty.call(expected, key))) throw new ClientInputError('Expected client fields are invalid')
    for (const key of changed) {
      const value = expected[key]
      if (key === 'telefonos' && value !== null && (!Array.isArray(value) || value.some((phone: unknown) => typeof phone !== 'number' || !Number.isFinite(phone)))) throw new ClientInputError('Expected phones are invalid')
      if (key === 'nombreCompleto' && value !== null && typeof value !== 'string') throw new ClientInputError('Expected name is invalid')
      if (key === 'deliveryZoneId' && value !== null && (typeof value !== 'string' || !/^[a-fA-F0-9]{24}$/.test(value))) throw new ClientInputError('Expected delivery zone is invalid')
      if (key === 'isActive' && value !== null && typeof value !== 'boolean') throw new ClientInputError('Expected status is invalid')
      contactFilter[key] = { $eq: value }
    }
  }
  const locationKeys = ['lat', 'lng', 'address'] as const
  const hasLocation = locationKeys.some((key) => Object.prototype.hasOwnProperty.call(fields, key))
  if (!hasLocation) {
    const response = await ClientModel.updateOne({ _id: id, ...contactFilter }, { $set: fields })
    if (response.matchedCount === 0) {
      if (await ClientModel.findById(id).lean() === null) throw new ClientNotFoundError()
      throw new ClientEditConflictError()
    }
    return response
  }
  const current = await ClientModel.findById(id).lean()
  if (current === null) throw new ClientNotFoundError()
  const changesLocation = locationKeys.some((key) => Object.prototype.hasOwnProperty.call(fields, key) && (fields[key] ?? null) !== (current[key] ?? null))
  const expected = (item as Client & { expectedLocation?: unknown }).expectedLocation
  // Legacy clients may omit the snapshot, so stale form values remain last-write-wins.
  if (managed && expected === undefined) throw new ClientLocationConflictError()
  if (expected !== undefined) {
    const parsed = expectedLocationSchema.safeParse(expected)
    if (!parsed.success || parsed.data.locationRevision !== (current.locationRevision ?? 0) || locationKeys.some((key) => parsed.data[key] !== (current[key] ?? null))) throw new ClientLocationConflictError()
  }
  const hasField = (key: string): boolean => Object.prototype.hasOwnProperty.call(fields, key)
  validateCoordinates(hasField('lat') ? fields.lat : current.lat, hasField('lng') ? fields.lng : current.lng)
  const clearAddress = hasField('address') && fields.address === null
  if (clearAddress) delete fields.address
  const unset = { ...(changesLocation ? { geocoding: 1 } : {}), ...(clearAddress ? { address: 1 } : {}) }
  const response = await ClientModel.updateOne(
    { _id: id, ...contactFilter, address: current.address ?? null, lat: current.lat ?? null, lng: current.lng ?? null, geocoding: current.geocoding ?? null, ...revisionFilter(current.locationRevision ?? 0) },
    { $set: fields, ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}), ...(changesLocation ? { $inc: { locationRevision: 1 } } : {}) },
    { runValidators: true }
  )
  if (response.matchedCount === 0) {
    const latest = await ClientModel.findById(id).lean()
    if (latest === null) throw new ClientNotFoundError()
    if (managed && Object.keys(contactFilter).length > 0) {
      const locationChanged = locationKeys.some((key) => (latest[key] ?? null) !== (current[key] ?? null)) ||
        (latest.locationRevision ?? 0) !== (current.locationRevision ?? 0) ||
        !isDeepStrictEqual(latest.geocoding ?? null, current.geocoding ?? null)
      const expected = expectedFields as Record<string, unknown>
      const contactChanged = Object.keys(contactFilter).some((key) => !matchesContactField(key, (latest as unknown as Record<string, unknown>)[key], expected[key]))
      // The diagnostic read is not atomic with the failed write; ambiguous outcomes stay generic.
      if (locationChanged && !contactChanged) throw new ClientLocationConflictError()
      throw new ClientEditConflictError()
    }
    throw new ClientLocationConflictError()
  }
  return response
}

const geocodeClient = async (id: Types.ObjectId, address?: string): Promise<GeocodingCandidate[]> => {
  const client = await ClientModel.findById(id).lean()
  if (client === null) throw new ClientNotFoundError()

  const addressToGeocode = address ?? client.address
  if (typeof addressToGeocode !== 'string' || addressToGeocode.trim() === '') {
    throw new Error('Client address is required')
  }

  return await geocode({ address: addressToGeocode })
}

const revisionFilter = (revision: number): Record<string, unknown> => revision === 0
  ? { $or: [{ locationRevision: 0 }, { locationRevision: { $exists: false } }] }
  : { locationRevision: revision }

const confirmLocation = async (id: Types.ObjectId, input: ClientLocationConfirmation, actorId: string): Promise<Client> => {
  const validatedBy = new Types.ObjectId(actorId)
  let fields: Record<string, unknown>
  let unset: Record<string, number> = {}
  if ('candidate' in input) {
    const { formattedAddress, placeId, precision, lat, lng } = input.candidate
    fields = {
      address: formattedAddress,
      lat,
      lng,
      geocoding: {
        status: GEOCODING_STATUS.CONFIRMED,
        source: GEOCODING_SOURCE.GEOCODED,
        formattedAddress,
        placeId,
        precision,
        validatedAt: new Date(),
        validatedBy
      }
    }
  } else if ('manualConfirmation' in input) {
    fields = {
      ...input.manualConfirmation,
      geocoding: {
        status: GEOCODING_STATUS.CONFIRMED,
        source: GEOCODING_SOURCE.MANUAL,
        validatedAt: new Date(),
        validatedBy
      }
    }
  } else {
    const { address, lat, lng } = input.manualReference
    fields = {
      address,
      ...(lat === undefined ? {} : { lat, lng }),
      geocoding: {
        status: GEOCODING_STATUS.PENDING,
        source: GEOCODING_SOURCE.MANUAL,
        formattedAddress: address,
        validatedBy
      }
    }
    if (lat === undefined) unset = { lat: 1, lng: 1 }
  }
  const reviewed = input.expectedLocation
  const filter = reviewed === undefined
    ? { _id: id }
    : { _id: id, address: reviewed.address, lat: reviewed.lat, lng: reviewed.lng, ...revisionFilter(reviewed.locationRevision) }
  const client = await ClientModel.findOneAndUpdate(filter, { $set: fields, $inc: { locationRevision: 1 }, ...(Object.keys(unset).length === 0 ? {} : { $unset: unset }) }, { new: true, runValidators: true })
  if (client === null) {
    if (await ClientModel.exists({ _id: id }) === null) throw new ClientNotFoundError()
    throw new ClientLocationConflictError()
  }
  return client
}

const getLocationSnapshot = async (id: Types.ObjectId): Promise<{ address: string | null, lat: number | null, lng: number | null, locationRevision: number }> => {
  const client = await ClientModel.findById(id, { _id: 0, address: 1, lat: 1, lng: 1, locationRevision: 1 }).lean()
  if (client === null) throw new ClientNotFoundError()
  return { address: client.address ?? null, lat: client.lat ?? null, lng: client.lng ?? null, locationRevision: client.locationRevision ?? 0 }
}

export {
  ClientNotFoundError,
  ClientLocationConflictError,
  ClientLocationInputError,
  ClientInputError,
  ClientEditConflictError,
  confirmLocation,
  geocodeClient,
  getClient,
  getLocationSnapshot,
  getClients,
  getSaleClientOptions,
  getSaleClientOptionsPage,
  insertClient,
  updateClient,
  getClientSearch
}
