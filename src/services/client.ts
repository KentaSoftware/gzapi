import { Types } from 'mongoose'
import ClientModel from '../models/client'
import { Client, GEOCODING_SOURCE, GEOCODING_STATUS } from '../interfaces/client.interface'
import type { ClientLocationConfirmation, GeocodingCandidate } from '../schemas/clientGeocoding'
import { geocode } from './geocodingProvider'

class ClientNotFoundError extends Error {
  constructor () {
    super('Client was not found')
    this.name = 'ClientNotFoundError'
  }
}

const insertClient = async (item: Client): Promise<Client> => {
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
        telefonos: 1
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
        telefonos: 1
      }
    },
    { $sort: { nombreCompleto: 1 } }
  ])
  return response
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
        telefonos: 1
      }
    }
  ])
  return response?.[0]
}

const updateClient = async (id: Types.ObjectId, item: Client): Promise<any> => {
  const response = await ClientModel.updateOne({ _id: id }, { $set: item })
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

const confirmLocation = async (id: Types.ObjectId, input: ClientLocationConfirmation, actorId: string): Promise<Client> => {
  const client = await ClientModel.findById(id)
  if (client === null) throw new ClientNotFoundError()

  const validatedBy = new Types.ObjectId(actorId)
  if ('candidate' in input) {
    const { formattedAddress, placeId, precision, lat, lng } = input.candidate
    client.address = formattedAddress
    client.lat = lat
    client.lng = lng
    client.geocoding = {
      status: GEOCODING_STATUS.CONFIRMED,
      source: GEOCODING_SOURCE.GEOCODED,
      formattedAddress,
      placeId,
      precision,
      validatedAt: new Date(),
      validatedBy
    }
  } else {
    const { address, lat, lng } = input.manualReference
    client.address = address
    client.lat = lat
    client.lng = lng
    client.geocoding = {
      status: GEOCODING_STATUS.PENDING,
      source: GEOCODING_SOURCE.MANUAL,
      formattedAddress: address,
      validatedBy
    }
  }

  await client.save()
  return client
}

export {
  ClientNotFoundError,
  confirmLocation,
  geocodeClient,
  getClient,
  getClients,
  insertClient,
  updateClient,
  getClientSearch
}
