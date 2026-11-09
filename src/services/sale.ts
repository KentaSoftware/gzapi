import { Types } from 'mongoose'
import { SALE_DELIVERY_STATUS, Sale } from '../interfaces/sale.interface'
import SaleModel from '../models/sale'
import ClientModel from '../models/client'
import ItemSaleModel from '../models/itemSale'

class SaleInputError extends Error {}

const recordOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

const prepareSale = async (input: unknown, actorId: Types.ObjectId): Promise<Sale> => {
  const body = recordOf(input)
  if (body === null) throw new SaleInputError('La venta debe ser un objeto válido')
  if (Object.keys(body).some(key => key.startsWith('delivery.') || key.startsWith('$'))) {
    throw new SaleInputError('Los datos de entrega no son válidos')
  }
  if (typeof body.idCliente !== 'string' || !/^[a-f\d]{24}$/i.test(body.idCliente)) {
    throw new SaleInputError('Seleccione un cliente registrado y activo')
  }
  if (Object.prototype.hasOwnProperty.call(body, 'serviceDate') || Object.prototype.hasOwnProperty.call(body, 'deliveredAt')) {
    throw new SaleInputError('La fecha y confirmación de entrega no se indican al crear la venta')
  }
  if (body.delivery !== undefined) {
    const delivery = recordOf(body.delivery)
    if (delivery === null || Object.keys(delivery).some(key => key !== 'status') || delivery.status !== SALE_DELIVERY_STATUS.PENDING) {
      throw new SaleInputError('La entrega nueva debe estar pendiente y sin fecha')
    }
  }
  if (!Array.isArray(body.itemsSale) || body.itemsSale.length === 0) throw new SaleInputError('La venta debe incluir productos válidos')
  for (const entry of body.itemsSale) {
    const item = recordOf(entry)
    if (item === null || typeof item._id !== 'string' || !/^[a-f\d]{24}$/i.test(item._id) ||
      typeof item.cantidad !== 'number' || !Number.isFinite(item.cantidad) ||
      typeof item.total !== 'number' || !Number.isFinite(item.total) ||
      (item.precio !== undefined && (typeof item.precio !== 'number' || !Number.isFinite(item.precio)))) {
      throw new SaleInputError('Cada producto debe incluir identificador, cantidad, total y precio válidos')
    }
    const itemDocument = new ItemSaleModel({ idProducto: item._id, idVenta: new Types.ObjectId(), cantidad: item.cantidad, total: item.total, precioUnitario: item.precio, estado: true })
    if (itemDocument.validateSync() !== undefined) throw new SaleInputError('Los datos del producto no son válidos')
  }
  const client = await ClientModel.findById(body.idCliente)
  if (client == null || client.isActive !== true || typeof client.nombreCompleto !== 'string' || client.nombreCompleto.trim() === '') {
    throw new SaleInputError('Seleccione un cliente registrado y activo')
  }
  const sale = { ...body, user: actorId, idCliente: client._id, cliente: client.nombreCompleto, delivery: { status: SALE_DELIVERY_STATUS.PENDING } }
  const validationError = new SaleModel(sale).validateSync()
  if (validationError !== undefined) throw new SaleInputError('Los datos de la venta no son válidos')
  return sale as unknown as Sale
}

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

const sameDelivery = (input: unknown, existing: Sale['delivery'] | null | undefined): boolean => {
  if (input == null || existing == null) return input === existing
  const supplied = recordOf(input)
  if (supplied === null || Object.keys(supplied).some(key => !['status', 'serviceDate', 'deliveredAt', 'notes'].includes(key))) return false
  if (supplied.status !== existing.status || supplied.notes !== existing.notes) return false
  for (const key of ['serviceDate', 'deliveredAt'] as const) {
    const current = existing[key]
    const value = supplied[key]
    if (current == null || value == null) {
      if (current !== value) return false
    } else {
      if (!(value instanceof Date) && typeof value !== 'string') return false
      const timestamp = new Date(value).getTime()
      if (!Number.isFinite(timestamp) || timestamp !== current.getTime()) return false
    }
  }
  return true
}

const updateSale = async (id: Types.ObjectId, sale: Partial<Sale>): Promise<Sale | null> => {
  if (Object.keys(sale).some(key => key.startsWith('delivery.') || key.startsWith('$'))) {
    throw new SaleInputError('La entrega no se puede modificar desde la edición de venta')
  }
  const existingSale = await SaleModel.findById(id)
  if (existingSale == null) return null

  if (Object.prototype.hasOwnProperty.call(sale, 'delivery') && !sameDelivery(sale.delivery, existingSale.delivery)) {
    throw new SaleInputError('La entrega no se puede modificar desde la edición de venta')
  }
  const { delivery: _delivery, ...changes } = sale
  existingSale.set(changes)
  return await existingSale.save()
}

const qtySale = async (filterUser: any): Promise<any> => {
  if (filterUser != null && filterUser !== '') {
    const response = await SaleModel.countDocuments({ user: filterUser })
    return response
  }
  const response = await SaleModel.countDocuments()
  return response
}

export { SaleInputError, prepareSale, insertSale, getSale, getSales, updateSale, qtySale, getSalesLimit, deleteSaleService }
