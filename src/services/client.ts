import { Types } from 'mongoose'
import ClientModel from '../models/client'
import { Client } from '../interfaces/client.interface'

const insertClient = async (item: Client): Promise<Client> => {
  const responseInsert = await ClientModel.create(item)
  return responseInsert
}

const getClients = async (skip: number, limit: number): Promise<Client[]> => {
  const response = await ClientModel.aggregate(
    [
      {
        $lookup: {
          from: 'cities',
          localField: 'idCiudad',
          foreignField: '_id',
          as: 'ciudad'
        }
      },
      {
        $project: {
          nombreCompleto: 1,
          direccion: 1,
          telefonos: 1,
          ciudad: '$ciudad.descripcion'
        }
      },
      {
        $unwind: '$ciudad'
      },
      {
        $sort: { nombreCompleto: 1 }
      }
    ]
  ).skip(skip).limit(limit)
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

  const response = await ClientModel.aggregate(
    [
      {
        $lookup: {
          from: 'citys',
          localField: 'idCiudad',
          foreignField: '_id',
          as: 'ciudad'
        }
      },
      {
        $project: {
          nombreCompleto: 1,
          direccion: 1,
          telefonos: 1,
          ciudad: '$ciudad.descripcion'
        }
      },
      {
        $unwind: '$ciudad'
      },
      {
        $match: query
      },
      {
        $sort: { nombreCompleto: 1 }
      }
    ]
  )
  return response
}

const getClient = async (id: Types.ObjectId): Promise<any> => {
  const response = await ClientModel.aggregate(
    [
      {
        $match: {
          _id: {
            $eq: id
          }
        }
      },
      {
        $lookup: {
          from: 'cities',
          localField: 'idCiudad',
          foreignField: '_id',
          as: 'ciudad'
        }
      },
      {
        $project: {
          nombreCompleto: 1,
          direccion: 1,
          telefonos: 1,
          ciudad: '$ciudad.descripcion'
        }
      },
      {
        $unwind: '$ciudad'
      }
    ]
  )
  return response
}

const updateClient = async (id: Types.ObjectId, item: Client): Promise<any> => {
  const response = await ClientModel.updateOne({ _id: id }, { $set: item })
  return response
}

export { getClient, getClients, insertClient, updateClient, getClientSearch }
