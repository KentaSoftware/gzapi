import { Schema, model } from 'mongoose'
import { Product } from '../interfaces/product.interface'

const ProductSchema = new Schema<Product>(
  {
    descripcion: {
      type: String,
      required: true
    },
    stock: {
      type: Number,
      required: true
    },
    codigoBarra: {
      type: String
    },
    peso: {
      cantidad: {
        type: Number,
        maxDecimalPlaces: 2
      },
      unidad: {
        type: String
      }
    },
    bulto: {
      type: Number,
      maxDecimalPlaces: 2
    },
    sabor: {
      type: String
    },
    precioCompra: {
      type: Number,
      maxDecimalPlaces: 2
    },
    precioUnitario: {
      type: Number,
      required: true,
      maxDecimalPlaces: 2
    },
    precioBulto: {
      type: Number,
      maxDecimalPlaces: 2
    },
    precioDescuento: {
      type: Number,
      maxDecimalPlaces: 2
    },
    categoria: {
      type: Schema.ObjectId,
      ref: 'Categoria',
      required: true
    },
    marca: {
      type: Schema.ObjectId,
      ref: 'Marca',
      required: true
    },
    proveedor: {
      type: Schema.ObjectId,
      ref: 'Proveedor',
      required: true
    },
    path: {
      type: String
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
)

// Índices para batch catalog search
ProductSchema.index({ codigoBarra: 1 }) // Búsqueda por barcode exacto
ProductSchema.index({ proveedor: 1, descripcion: 1 }) // Búsqueda por proveedor + texto

const ProductModel = model('product', ProductSchema)
export default ProductModel
