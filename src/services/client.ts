import { Types } from 'mongoose'
import ClientModel from '../models/client'
import { Client } from '../interfaces/client.interface'

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
  let query: any = {
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

export { getClient, getClients, insertClient, updateClient, getClientSearch }
