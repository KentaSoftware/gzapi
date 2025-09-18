import { Types } from 'mongoose'
import { Product } from '../interfaces/product.interface'
import ProductModel from '../models/product'

const insertProduct = async (item: Product): Promise<Product> => {
  const responseInsert = await ProductModel.create(item)
  return responseInsert
}

const getAllProducts = async (): Promise<Product[]> => {
  return await ProductModel.aggregate(
    [
      {
        $lookup: {
          from: 'categories',
          localField: 'categoria',
          foreignField: '_id',
          as: 'categoria'
        }
      },
      {
        $lookup: {
          from: 'brands',
          localField: 'marca',
          foreignField: '_id',
          as: 'marca'
        }
      },
      {
        $lookup: {
          from: 'providers',
          localField: 'proveedor',
          foreignField: '_id',
          as: 'proveedor'
        }
      },
      {
        $project: {
          descripcion: 1,
          stock: 1,
          codigoBarra: 1,
          peso: 1,
          sabor: 1,
          bulto: 1,
          precioBulto: 1,
          precioCompra: 1,
          precioUnitario: 1,
          precioDescuento: 1,
          categoria: '$categoria._id',
          proveedor: '$proveedor._id',
          marca: '$marca._id',
          NameProveedor: '$proveedor.descripcion',
          NameMarca: '$marca.descripcion',
          NameCategoria: '$categoria.descripcion',
          createdAt: 1,
          updatedAt: 1
        }
      },
      {
        $unwind: '$categoria'
      },
      {
        $unwind: '$proveedor'
      },
      {
        $unwind: '$marca'
      },
      {
        $unwind: '$NameProveedor'
      },
      {
        $unwind: '$NameMarca'
      },
      {
        $unwind: '$NameCategoria'
      },
      {
        $sort: { descripcion: 1 }
      }
    ]
  )
}

const getAllProductsCategories = async (categories: string[] | undefined): Promise<any[]> => {
  let query: any = {

  }

  if (categories !== undefined) {
    if (categories?.length !== 0) {
      query = { NameCategoria: { $in: categories } }
    }
  } else {
    query = {}
  }

  return await ProductModel.aggregate([
    {
      $lookup: {
        from: 'categories',
        localField: 'categoria',
        foreignField: '_id',
        as: 'categoria'
      }
    },
    {
      $lookup: {
        from: 'brands',
        localField: 'marca',
        foreignField: '_id',
        as: 'marca'
      }
    },
    {
      $lookup: {
        from: 'providers',
        localField: 'proveedor',
        foreignField: '_id',
        as: 'proveedor'
      }
    },
    {
      $unwind: '$categoria'
    },
    {
      $unwind: '$proveedor'
    },
    {
      $unwind: '$marca'
    },
    {
      $project: {
        _id: 0, // Excluimos el _id
        descripcion: 1,
        stock: 1,
        codigoBarra: 1,
        peso: 1,
        sabor: 1,
        bulto: 1,
        precioBulto: 1,
        precioCompra: 1,
        precioUnitario: 1,
        precioDescuento: 1,
        categoria: '$categoria._id',
        proveedor: '$proveedor._id',
        marca: '$marca._id',
        NameCategoria: '$categoria.descripcion',
        NameProveedor: '$proveedor.descripcion',
        NameMarca: '$marca.descripcion',
        createdAt: 1,
        updatedAt: 1
      }
    },
    {
      $match: query
    },
    {
      $sort: { NameCategoria: 1 }
    }
    /* {
      $group: {
        _id: '$categoria', // Agrupamos por el nombre de la categoría
        productos: {
          $push: {
            descripcion: '$descripcion',
            stock: '$stock',
            codigoBarra: '$codigoBarra',
            peso: '$peso',
            sabor: '$sabor',
            bulto: '$bulto',
            precioBulto: '$precioBulto',
            precioCompra: '$precioCompra',
            precioUnitario: '$precioUnitario',
            precioDescuento: '$precioDescuento',
            proveedor: '$proveedor', // Nombre del proveedor
            marca: '$marca' // Nombre de la marca
          }
        }
      }
    },
    {
      $project: {
        _id: 0, // Excluimos el _id
        categoria: '$_id', // Mantenemos el nombre de la categoría
        productos: 1 // Mantenemos la lista de productos
      }
    } */
  ])
}

const getProducts = async (skip: number, limit: number, userRole?: any): Promise<Product[]> => {

  if (userRole && userRole.name === 'admin') {
    // Agregamos un $match para filtrar productos con precioUnitario > 1
    return await ProductModel.aggregate(
      [
        {
          $lookup: {
            from: 'categories',
            localField: 'categoria',
            foreignField: '_id',
            as: 'categoria'
          }
        },
        {
          $lookup: {
            from: 'brands',
            localField: 'marca',
            foreignField: '_id',
            as: 'marca'
          }
        },
        {
          $lookup: {
            from: 'providers',
            localField: 'proveedor',
            foreignField: '_id',
            as: 'proveedor'
          }
        },
        {
          $project: {
            descripcion: 1,
            stock: 1,
            codigoBarra: 1,
            peso: 1,
            /* sabor: 1, */
            bulto: 1,
            precioBulto: 1,
            precioCompra: 1,
            precioUnitario: 1,
            precioDescuento: 1,
            categoria: '$categoria._id',
            proveedor: '$proveedor._id',
            marca: '$marca._id',
            NameProveedor: '$proveedor.descripcion',
            NameMarca: '$marca.descripcion',
            NameCategoria: '$categoria.descripcion',
            createdAt: 1,
            updatedAt: 1,
            descripcionLower: { $toLower: '$descripcion' }
          }
        },
        {
          $unwind: '$categoria'
        },
        {
          $unwind: '$proveedor'
        },
        {
          $unwind: '$marca'
        },
        {
          $unwind: '$NameProveedor'
        },
        {
          $unwind: '$NameMarca'
        },
        {
          $unwind: '$NameCategoria'
        },
        {
          $sort: { descripcionLower: 1 }
        }
      ]
    ).skip(skip).limit(limit)
  }
  return await ProductModel.aggregate(
    [
      {
        $lookup: {
          from: 'categories',
          localField: 'categoria',
          foreignField: '_id',
          as: 'categoria'
        }
      },
      {
        $lookup: {
          from: 'brands',
          localField: 'marca',
          foreignField: '_id',
          as: 'marca'
        }
      },
      {
        $lookup: {
          from: 'providers',
          localField: 'proveedor',
          foreignField: '_id',
          as: 'proveedor'
        }
      },
      {
        $project: {
          descripcion: 1,
          stock: 1,
          codigoBarra: 1,
          peso: 1,
          /* sabor: 1, */
          bulto: 1,
          precioBulto: 1,
          precioCompra: 1,
          precioUnitario: 1,
          precioDescuento: 1,
          categoria: '$categoria._id',
          proveedor: '$proveedor._id',
          marca: '$marca._id',
          NameProveedor: '$proveedor.descripcion',
          NameMarca: '$marca.descripcion',
          NameCategoria: '$categoria.descripcion',
          createdAt: 1,
          updatedAt: 1,
          descripcionLower: { $toLower: '$descripcion' }
        }
      },
      {
        $match: {
          precioUnitario: { $gt: 1 }
        }
      },
      {
        $unwind: '$categoria'
      },
      {
        $unwind: '$proveedor'
      },
      {
        $unwind: '$marca'
      },
      {
        $unwind: '$NameProveedor'
      },
      {
        $unwind: '$NameMarca'
      },
      {
        $unwind: '$NameCategoria'
      },
      {
        $sort: { descripcionLower: 1 }
      }
    ]
  ).skip(skip).limit(limit)
}

const getProductsSearch = async (input: string, filter: Filter, userRole?: any): Promise<Product[]> => {
  let query: any = {
  }

  if (input !== '') {
    query.descripcion = {
      $regex: input,
      $options: 'i'
    }
  }

  if (filter.categoria !== undefined || filter.marca !== undefined || filter.proveedor !== undefined) {
    query = Object.assign({}, query, filter)
  }

  if (userRole && userRole.name === 'admin') {
    return await ProductModel.aggregate(
      [
        {
          $lookup: {
            from: 'categories',
            localField: 'categoria',
            foreignField: '_id',
            as: 'categoria'
          }
        },
        {
          $lookup: {
            from: 'brands',
            localField: 'marca',
            foreignField: '_id',
            as: 'marca'
          }
        },
        {
          $lookup: {
            from: 'providers',
            localField: 'proveedor',
            foreignField: '_id',
            as: 'proveedor'
          }
        },
        {
          $project: {
            descripcion: 1,
            stock: 1,
            codigoBarra: 1,
            precioUnitario: 1,
            precioDescuento: 1,
            categoria: '$categoria._id',
            marca: '$marca._id',
            proveedor: '$proveedor._id',
            NameMarca: '$marca.descripcion',
            NameCategoria: '$categoria.descripcion',
            NameProveedor: '$proveedor.descripcion',
            createdAt: 1,
            updatedAt: 1
          }
        },
        {
          $unwind: '$categoria'
        },
        {
          $unwind: '$marca'
        },
        {
          $unwind: '$proveedor'
        },
        {
          $unwind: '$NameMarca'
        },
        {
          $unwind: '$NameCategoria'
        },
        {
          $unwind: '$NameProveedor'
        },
        {
          $match: query
        },
        {
          $sort: { descripcion: 1 }
        }
      ]
    )
  }

  return await ProductModel.aggregate(
    [
      {
        $lookup: {
          from: 'categories',
          localField: 'categoria',
          foreignField: '_id',
          as: 'categoria'
        }
      },
      {
        $lookup: {
          from: 'brands',
          localField: 'marca',
          foreignField: '_id',
          as: 'marca'
        }
      },
      {
        $lookup: {
          from: 'providers',
          localField: 'proveedor',
          foreignField: '_id',
          as: 'proveedor'
        }
      },
      {
        $project: {
          descripcion: 1,
          stock: 1,
          codigoBarra: 1,
          precioUnitario: 1,
          precioDescuento: 1,
          categoria: '$categoria._id',
          marca: '$marca._id',
          proveedor: '$proveedor._id',
          NameMarca: '$marca.descripcion',
          NameCategoria: '$categoria.descripcion',
          NameProveedor: '$proveedor.descripcion',
          createdAt: 1,
          updatedAt: 1
        }
      },
      {
        $match: {
          precioUnitario: { $gt: 1 }
        }
      },
      {
        $unwind: '$categoria'
      },
      {
        $unwind: '$marca'
      },
      {
        $unwind: '$proveedor'
      },
      {
        $unwind: '$NameMarca'
      },
      {
        $unwind: '$NameCategoria'
      },
      {
        $unwind: '$NameProveedor'
      },
      {
        $match: query
      },
      {
        $sort: { descripcion: 1 }
      }
    ]
  )
}

const getProduct = async (id: Types.ObjectId): Promise<any> => {
  return await ProductModel.aggregate(
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
          from: 'categories',
          localField: 'categoria',
          foreignField: '_id',
          as: 'categoria'
        }
      },
      {
        $lookup: {
          from: 'brands',
          localField: 'marca',
          foreignField: '_id',
          as: 'marca'
        }
      },
      {
        $lookup: {
          from: 'providers',
          localField: 'proveedor',
          foreignField: '_id',
          as: 'proveedor'
        }
      },
      {
        $project: {
          descripcion: 1,
          stock: 1,
          codigoBarra: 1,
          peso: 1,
          sabor: 1,
          bulto: 1,
          precioBulto: 1,
          precioCompra: 1,
          precioUnitario: 1,
          precioDescuento: 1,
          porcentaje: 1,
          categoria: '$categoria._id',
          proveedor: '$proveedor._id',
          marca: '$marca._id',
          NameProveedor: '$proveedor.descripcion',
          NameMarca: '$marca.descripcion',
          NameCategoria: '$categoria.descripcion',
          createdAt: 1,
          updatedAt: 1
        }
      },
      {
        $unwind: '$categoria'
      },
      {
        $unwind: '$proveedor'
      },
      {
        $unwind: '$marca'
      },
      {
        $unwind: '$NameProveedor'
      },
      {
        $unwind: '$NameMarca'
      },
      {
        $unwind: '$NameCategoria'
      }
    ]
  )
}

const updateProduct = async (id: Types.ObjectId, item: Partial<Product>, context?: { userId?: string }): Promise<any> => {
  const response = await ProductModel.updateOne({ _id: id }, { $set: item }, { context })
  return response
}

const qtyProduct = async (): Promise<any> => {
  const response = await ProductModel.countDocuments()
  return response
}

export interface Filter {
  categoria?: string
  proveedor?: string
  marca?: string
}

const findProducts = async (filter: Filter): Promise<any> => {
  const query = []

  if (filter.categoria !== undefined) {
    query.push({ categoria: filter.categoria })
  }

  if (filter.proveedor !== undefined) {
    query.push({ proveedor: filter.proveedor })
  }

  if (filter.marca !== undefined) {
    query.push({ marca: filter.marca })
  }

  const response = await ProductModel.find({ $and: query })

  return response
}

// Consulta para obtener la última fecha de updatedAt y createdAt de los productos
const getUltimasFechasProductoService = async (): Promise<{ ultimaCreatedAt: Date | null, ultimaUpdatedAt: Date | null }> => {
  // Obtener el producto con la fecha de creación más reciente
  const ultimoCreado = await ProductModel.findOne({}, { createdAt: 1 }).sort({ createdAt: -1 }).lean() as Product;
  // Obtener el producto con la fecha de actualización más reciente
  const ultimoActualizado = await ProductModel.findOne({}, { updatedAt: 1 }).sort({ updatedAt: -1 }).lean() as Product;

  // Restar 3 horas a las fechas si existen
  let ultimaCreatedAt: Date | null = null;
  let ultimaUpdatedAt: Date | null = null;

  if (ultimoCreado?.createdAt) {
    ultimaCreatedAt = new Date(ultimoCreado.createdAt);
    ultimaCreatedAt.setHours(ultimaCreatedAt.getHours() - 3);
  }

  if (ultimoActualizado?.updatedAt) {
    ultimaUpdatedAt = new Date(ultimoActualizado.updatedAt);
    ultimaUpdatedAt.setHours(ultimaUpdatedAt.getHours() - 3);
  }

  return {
    ultimaCreatedAt,
    ultimaUpdatedAt
  };
};


export { getProduct, getProducts, insertProduct, updateProduct, getProductsSearch, findProducts, qtyProduct, getAllProducts, getAllProductsCategories, getUltimasFechasProductoService }
