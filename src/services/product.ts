import { Types } from 'mongoose'
import { Product } from '../interfaces/product.interface'
import ProductModel from '../models/product'

const insertProduct = async (item: Product): Promise<Product> => {
  console.log("item insertProduct", item)
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
  console.log('skip getProducts service', skip, limit)
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

  console.log('query', query)

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

const updateProduct = async (id: Types.ObjectId, item: Partial<Product>): Promise<any> => {
  const response = await ProductModel.updateOne({ _id: id }, { $set: item })
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

export { getProduct, getProducts, insertProduct, updateProduct, getProductsSearch, findProducts, qtyProduct, getAllProducts, getAllProductsCategories }
