import { Types } from 'mongoose'
import { Sale } from '../interfaces/sale.interface'
import SaleModel from '../models/sale'

const insertSale = async (item: Sale): Promise<Sale> => {
  const responseInsert = await SaleModel.create(item)
  return responseInsert
}

const deleteSaleService = async (id: Types.ObjectId): Promise<any> => {
  const response = await SaleModel.updateOne({ _id: id }, { $set: { estado: 'Cancelado' } })
  return response
}

const getSales = async (input: string, user: Types.ObjectId, userRole?: any): Promise<Sale[]> => {
  const query: any = {}

  if (input !== '') {
    query.cliente = {
      $regex: input,
      $options: 'i'
    }
  }

  console.log('query', query)

  // Si el usuario es admin, no filtrar por usuario
  if (userRole != null && userRole.name === 'admin') {
    const response = await SaleModel.aggregate([
      {
        $match: { ...query }
      },
      {
        $sort: { createdAt: -1 }
      },
      {
        $lookup: {
          from: 'users',
          localField: 'user',
          foreignField: '_id',
          as: 'user'
        }
      },
      {
        $lookup: {
          from: 'itemsales',
          localField: '_id',
          foreignField: 'idVenta',
          as: 'itemSales'
        }
      },
      {
        $addFields: {
          itemsLength: { $size: '$itemSales' },
          userCreate: '$user.nickname'
        }
      },
      {
        $project: {
          itemSales: 0,
          user: 0
        }
      }
    ])
    return response
  }

  // Si no es admin, filtrar por usuario
  const response = await SaleModel.aggregate([{
    $match: { ...query, user }
  },
  {
    $sort: { createdAt: -1 }
  },
  {
    $lookup: {
      from: 'itemsales',
      localField: '_id',
      foreignField: 'idVenta',
      as: 'itemSales'
    }
  },
  {
    $addFields: {
      itemsLength: { $size: '$itemSales' }
    }
  },
  {
    $project: {
      itemSales: 0
    }
  }
  ])

  return response
}

const getSalesLimit = async (skip: number, limit: number, user: Types.ObjectId, userRole?: any, filterUser?: any): Promise<Sale[]> => {
  const query: any = {}

  // Si el usuario es admin, no filtrar por usuario
  if (filterUser != null && filterUser !== '') {
    query.user = new Types.ObjectId(filterUser)
  }

  console.log(query)

  if (userRole != null && userRole.name === 'admin') {
    const response = await SaleModel.aggregate([
      {
        $sort: { createdAt: -1 }
      },
      {
        $match: { ...query }
      },
      {
        $skip: skip
      },
      {
        $limit: limit
      },
      {
        $lookup: {
          from: 'users',
          localField: 'user',
          foreignField: '_id',
          as: 'user'
        }
      },
      {
        $unwind: '$user'
      },
      {
        $lookup: {
          from: 'itemsales',
          localField: '_id',
          foreignField: 'idVenta',
          as: 'itemSales'
        }
      },
      {
        $addFields: {
          itemsLength: { $size: '$itemSales' },
          userCreate: '$user.nickname'
        }
      },
      {
        $project: {
          itemSales: 0,
          user: 0
        }
      }
    ])
    return response
  }

  // Si no es admin, filtrar por usuario
  const response = await SaleModel.aggregate([
    {
      $match: { user }
    },
    {
      $sort: { createdAt: -1 }
    },
    {
      $skip: skip
    },
    {
      $limit: limit
    },
    {
      $lookup: {
        from: 'itemsales',
        localField: '_id',
        foreignField: 'idVenta',
        as: 'itemSales'
      }
    },
    {
      $addFields: {
        itemsLength: { $size: '$itemSales' }
      }
    },
    {
      $project: {
        itemSales: 0
      }
    }
  ])
  return response
}

const getSale = async (id: Types.ObjectId): Promise<Sale[]> => {
  const response = await SaleModel.find({ _id: id })
  return response
}

const updateSale = async (id: Types.ObjectId, sale: Sale): Promise<any> => {
  const response = await SaleModel.updateOne({ _id: id }, { $set: sale })
  return response
}

const qtySale = async (filterUser: any): Promise<any> => {
  if (filterUser != null && filterUser !== '') {
    const response = await SaleModel.countDocuments({ user: filterUser })
    return response
  }
  const response = await SaleModel.countDocuments()
  return response
}

export { insertSale, getSale, getSales, updateSale, qtySale, getSalesLimit, deleteSaleService }
