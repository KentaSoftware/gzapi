import { Types } from 'mongoose'
import { ItemSale } from '../interfaces/sale.interface'
import ItemSaleModel from '../models/itemSale'
import { endOfWeek, startOfWeek, subWeeks } from 'date-fns'

const insertItemSale = async (item: ItemSale): Promise<ItemSale> => {
  const responseInsert = await ItemSaleModel.create(item)
  return responseInsert
}

const getItemSales = async (): Promise<ItemSale[]> => {
  const response = await ItemSaleModel.find({})
  return response
}

const getItemSale = async (id: Types.ObjectId): Promise<any> => {
  return await ItemSaleModel.aggregate(
    [
      {
        $match: {
          idVenta: id,
          $or: [
            { estado: true },
            { estado: { $exists: false } }
          ]
        }
      },
      {
        $lookup: {
          from: 'products',
          localField: 'idProducto',
          foreignField: '_id',
          as: 'producto'
        }
      },
      {
        $unwind: '$producto'
      },
      {
        $project: {
          idVenta: 1,
          _id: 1,
          idProducto: 1,
          cantidad: 1,
          total: 1,
          precioUnitario: '$producto.precioUnitario',
          precio: '$precioUnitario',
          descripcion: '$producto.descripcion',
          stock: '$producto.stock',
          peso: '$producto.peso',
          sabor: '$producto.sabor',
          categoria: '$producto.categoria'
        }
      },
      {
        $lookup: {
          from: 'categories',
          localField: 'categoria',
          foreignField: '_id',
          as: 'categoria'
        }
      },
      {
        $unwind: '$categoria'
      },
      {
        $project: {
          _id: 1,
          estado: 1,
          idVenta: 1,
          idProducto: 1,
          cantidad: 1,
          total: 1,
          modificado: 1,
          precioUnitario: 1,
          precio: 1,
          descripcion: 1,
          stock: 1,
          peso: 1,
          sabor: 1,
          categoria: '$categoria.descripcion'
        }
      },
      {
        $sort: { descripcion: 1 } // Ordena alfabéticamente por el campo 'descripcion' (1 = ascendente, -1 = descendente)
      }
    ]
  );
}

const updateItemsSale = async (id: Types.ObjectId, item: Partial<ItemSale>): Promise<any> => {
  const response = await ItemSaleModel.updateOne({ _id: id }, { $set: item })
  return response
}

const deleteItemsSale = async (id: Types.ObjectId): Promise<any> => {
  const response = await ItemSaleModel.deleteOne({ _id: id })
  return response
}

const getListBuyAvg = async (prov: string): Promise<any> => {

  const hoy = new Date();
  const startDate = startOfWeek(subWeeks(hoy, 4));
  const endDate = endOfWeek(subWeeks(hoy, 1));

  try {
    const result = await ItemSaleModel.aggregate([
      {
        $match: {
          createdAt: {
            $gte: startDate,
            $lte: endDate
          },
          $or: [
            { estado: true },
            { estado: { $exists: false } }
          ]
        }
      },
      {
        $group: {
          _id: {
            week: { $week: "$createdAt" },
            productId: "$idProducto"
          },
          weeklySales: { $sum: "$cantidad" },
          createdAt: { $first: "$createdAt" },
          precioCompra: { $first: "$precioCompra" }
        }
      },
      {
        $group: {
          _id: "$_id.productId",
          totalSales: { $sum: "$weeklySales" },
          weeklyAverages: { $avg: "$weeklySales" },
          productDetails: { $first: "$productData" }
        }
      },
      {
        $lookup: {
          from: 'products',
          localField: '_id',
          foreignField: '_id',
          as: 'producto'
        }
      },
      {
        $unwind: '$producto'
      },
      {
        $lookup: {
          from: 'providers',
          localField: 'producto.proveedor',
          foreignField: '_id',
          as: 'proveedor'
        }
      },
      {
        $unwind: '$proveedor'
      },
      {
        $project: {
          _id: 0,
          idProducto: '$producto._id',
          descripcion: '$producto.descripcion',
          precio: '$producto.precioCompra',
          proveedor: '$proveedor.descripcion',
          totalVendido: '$totalSales',
          cantidad: { $ceil: '$weeklyAverages' },
          total: { $multiply: ['$producto.precioCompra', { $ceil: '$weeklyAverages' }] }
        }
      },
      {
        $match: {
          proveedor: prov,
        }
      },
      {
        $sort: { descripcion: -1 }
      }
    ]);

    return result;
  } catch (error) {
    console.error('Error en la consulta:', error);
    throw error;
  }
};

const getListBuyByDateRange = async (start: string, end: string, prov: string): Promise<any> => {

  const startDate = new Date(start);
  const endDate = new Date(end);

  const response = await ItemSaleModel.aggregate([
    {
      $lookup: {
        from: 'sales',
        localField: 'idVenta',
        foreignField: '_id',
        as: 'venta'
      }
    },
    {
      $unwind: '$venta'
    },
    {
      $project: {
        _id: 0,
        idProducto: 1,
        cantidad: 1,
        idVenta: 1,
        total: 1,
        precioUnitario: 1,
        estado: 1,
        fechaVenta: '$venta.createdAt',
        createdAt: 1
      }
    },
    {
      $match: {
        fechaVenta: {
          $gte: startDate,
          $lte: endDate
        },
        $or: [
          { estado: true },
          { estado: { $exists: false } }
        ]
      }
    },
    {
      $group: {
        _id: "$idProducto",
        cantidad: { $sum: "$cantidad" },
        createdAt: { $first: "$createdAt" }
      }
    },
    {
      $lookup: {
        from: 'products',
        localField: '_id',
        foreignField: '_id',
        as: 'producto'
      }
    },
    {
      $unwind: '$producto'
    },

    {
      $lookup: {
        from: 'providers',
        localField: 'producto.proveedor',
        foreignField: '_id',
        as: 'proveedor'
      }
    },
    {
      $unwind: '$proveedor'
    },
    {
      $project: {
        _id: 0,
        idProducto: '$producto._id',
        descripcion: '$producto.descripcion',
        precio: { $ifNull: ['$producto.precioCompra', '$producto.precioUnitario'] },
        proveedor: '$proveedor.descripcion',
        cantidad: 1,
        createdAt: "$createdAt",
        total: { $multiply: [{ $ifNull: ['$producto.precioCompra', '$producto.precioUnitario'] }, '$cantidad'] },
        fechaVenta: 1,
      }
    },
    {
      $match: {
        proveedor: prov,
      }
    },
    {
      $sort: { descripcion: -1 }
    }
  ])

  return response
}

export { insertItemSale, getItemSales, getItemSale, updateItemsSale, deleteItemsSale, getListBuyAvg, getListBuyByDateRange }
