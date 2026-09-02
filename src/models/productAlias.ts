import { Schema, model } from 'mongoose'
import { IProductAlias, AliasType } from '../interfaces/catalog.interface'

const ProductAliasSchema = new Schema<IProductAlias>(
  {
    providerId: {
      type: Schema.Types.ObjectId,
      ref: 'provider',
      required: [true, 'El proveedor es obligatorio'],
      index: true
    },
    aliasType: {
      type: String,
      enum: Object.values(AliasType),
      required: [true, 'El tipo de alias es obligatorio']
    },
    aliasValueRaw: {
      type: String,
      required: [true, 'El valor raw del alias es obligatorio'],
      trim: true
    },
    aliasValueNormalized: {
      type: String,
      required: [true, 'El valor normalizado del alias es obligatorio'],
      uppercase: true,
      trim: true
    },
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'product',
      required: [true, 'El producto es obligatorio'],
      index: true
    },
    confidence: {
      type: Number,
      min: 0,
      max: 1,
      default: 0.95 // Alta confianza por defecto (confirmación humana)
    },
    stats: {
      usedCount: {
        type: Number,
        default: 1
      },
      lastUsedAt: {
        type: Date,
        default: null
      },
      lastUsedBy: {
        type: Schema.Types.ObjectId,
        ref: 'user',
        default: null
      }
    },
    isActive: {
      type: Boolean,
      default: true
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'user',
      required: [true, 'El usuario creador es obligatorio']
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
)

// ============================================
// ÍNDICES
// ============================================

// Índice único: un alias normalizado por proveedor y tipo solo puede apuntar a un producto
ProductAliasSchema.index(
  { providerId: 1, aliasType: 1, aliasValueNormalized: 1 },
  { unique: true, name: 'idx_unique_alias' }
)

// Índice para buscar todos los aliases de un producto en un proveedor
ProductAliasSchema.index(
  { providerId: 1, productId: 1 },
  { name: 'idx_provider_product' }
)

// Índice para búsqueda por valor normalizado (sin restricción de proveedor)
ProductAliasSchema.index(
  { aliasValueNormalized: 1, aliasType: 1 },
  { name: 'idx_alias_lookup' }
)

// Índice para listar aliases activos por proveedor (snapshot)
ProductAliasSchema.index(
  { providerId: 1, isActive: 1, updatedAt: -1 },
  { name: 'idx_provider_active' }
)

const ProductAliasModel = model<IProductAlias>('productAlias', ProductAliasSchema)
export default ProductAliasModel
