import { Types } from 'mongoose'
import ClientModel from '../models/client'
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

const containsGeocodingKey = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false
  return Object.entries(value).some(([key, nested]) => key === 'geocoding' || key.startsWith('geocoding.') || key === 'locationRevision' || key.startsWith('locationRevision.') || containsGeocodingKey(nested))
}

const insertClient = async (item: Client): Promise<Client> => {
  if (containsGeocodingKey(item)) throw new ClientLocationInputError()
  const responseInsert = await ClientModel.create(item)
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
        locationRevision: { $ifNull: ['$locationRevision', 0] }
      }
    },
    { $sort: { nombreCompleto: 1 } }
  ])
    .skip(skip)
    .limit(limit)
  return response
}

const getClientSearch = async (input: string): Promise<Client[]> => {
  const query: any = {
  }

  if (input !== '') {
    query.nombreCompleto = {
      $regex: input,
      $options: 'i'
    }
  }

  const response = await ClientModel.aggregate([
    { $match: query },
    {
      $project: {
        nombreCompleto: 1,
        address: 1,
        lat: 1,
        lng: 1,
        telefonos: 1,
        locationRevision: { $ifNull: ['$locationRevision', 0] }
      }
    },
    { $sort: { nombreCompleto: 1 } }
  ])
  return response
}

const getSaleClientOptions = async (input: string): Promise<Array<{ id: string, name: string, address?: string }>> => {
  const literal = input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const clients = await ClientModel.find(
    { isActive: true, nombreCompleto: new RegExp(`^${literal}`, 'i') },
    { _id: 1, nombreCompleto: 1, address: 1 }
  ).sort({ nombreCompleto: 1, _id: 1 }).limit(20).maxTimeMS(5000).lean()
  return clients.map((client) => ({
    id: String(client._id),
    name: client.nombreCompleto,
    ...(typeof client.address === 'string' ? { address: client.address } : {})
  }))
}

interface SaleClientCursor {
  id: string
  query: string
}

const getSaleClientOptionsPage = async (input: string, limit: number, cursor?: SaleClientCursor): Promise<{ clients: Array<{ id: string, name: string, address?: string }>, nextCursor: string | null }> => {
  const literal = input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const clients = await ClientModel.find(
    {
      isActive: true,
      ...(input === '' ? {} : { nombreCompleto: new RegExp(`^${literal}`, 'i') }),
      ...(cursor === undefined ? {} : { _id: { $gt: new Types.ObjectId(cursor.id) } })
    },
    { _id: 1, nombreCompleto: 1, address: 1 }
  ).sort({ _id: 1 }).limit(limit + 1).maxTimeMS(5000).lean()
  const page = clients.slice(0, limit)
  const last = page[page.length - 1]
  const nextCursor = clients.length > limit
    ? Buffer.from(JSON.stringify({ id: String(last._id), query: input })).toString('base64url')
    : null
  return {
    clients: page.map((client) => ({
      id: String(client._id),
      name: typeof client.nombreCompleto === 'string' && client.nombreCompleto.trim() !== '' ? client.nombreCompleto : 'Sin nombre',
      ...(typeof client.address === 'string' ? { address: client.address } : {})
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
        locationRevision: { $ifNull: ['$locationRevision', 0] }
      }
    }
  ])
  return response?.[0]
}

const updateClient = async (id: Types.ObjectId, item: Client): Promise<any> => {
  const fields = Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'expectedLocation' && key !== 'geocoding' && !key.startsWith('geocoding.') && key !== 'locationRevision' && !key.startsWith('locationRevision.') && !key.startsWith('$')))
  const locationKeys = ['lat', 'lng', 'address'] as const
  const hasLocation = locationKeys.some((key) => Object.prototype.hasOwnProperty.call(fields, key))
  if (!hasLocation) return await ClientModel.updateOne({ _id: id }, { $set: fields })
  const current = await ClientModel.findById(id).lean()
  if (current === null) throw new ClientNotFoundError()
  const changesLocation = locationKeys.some((key) => Object.prototype.hasOwnProperty.call(fields, key) && (fields[key] ?? null) !== (current[key] ?? null))
  const expected = (item as Client & { expectedLocation?: unknown }).expectedLocation
  if (expected !== undefined) {
    const parsed = expectedLocationSchema.safeParse(expected)
    if (!parsed.success || parsed.data.locationRevision !== (current.locationRevision ?? 0) || locationKeys.some((key) => parsed.data[key] !== (current[key] ?? null))) throw new ClientLocationConflictError()
  }
  const response = await ClientModel.updateOne(
    { _id: id, address: current.address ?? null, lat: current.lat ?? null, lng: current.lng ?? null, geocoding: current.geocoding ?? null, ...revisionFilter(current.locationRevision ?? 0) },
    { $set: fields, ...(changesLocation ? { $unset: { geocoding: 1 }, $inc: { locationRevision: 1 } } : {}) }
  )
  if (response.matchedCount === 0) throw new ClientLocationConflictError()
  return response
}

const geocodeClient = async (id: Types.ObjectId, address?: string): Promise<GeocodingCandidate[]> => {
  const client = await ClientModel.findById(id).lean()
  if (client === null) throw new ClientNotFoundError()

  const addressToGeocode = address ?? client.address
  if (addressToGeocode === undefined || addressToGeocode.trim() === '') {
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
