import { Schema, model } from 'mongoose'
import { BASELINE_STATUS, EXPIRY_TRACKING } from '../interfaces/stock.interface'
import type { Product, ProductInventoryConfig } from '../interfaces/product.interface'

const ProductInventoryConfigSchema = new Schema<ProductInventoryConfig>(
  {
    minimum: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: 'minimum must be a non-negative integer'
      }
    },
    expiryAlertDays: {
      type: Number,
      min: 0,
      max: 3650,
      validate: {
        validator: Number.isSafeInteger,
        message: 'expiryAlertDays must be a safe integer between 0 and 3650'
      }
    },
    expiryTracking: {
      type: String,
      required: true,
      enum: Object.values(EXPIRY_TRACKING)
    },
    baselineStatus: {
      type: String,
      required: true,
      enum: Object.values(BASELINE_STATUS)
    },
    lastReconciledAt: {
      type: Date
    },
    lastReconciledBy: {
      type: Schema.Types.ObjectId,
      ref: 'user'
    }
  },
  {
    _id: false,
    versionKey: false
  }
)

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
    },
    inventory: {
      type: ProductInventoryConfigSchema,
      required: false
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
