import { Schema, model } from 'mongoose'
import { ICatalogVersion, CatalogVersionReason } from '../interfaces/catalog.interface'

const CatalogVersionSchema = new Schema<ICatalogVersion>(
  {
    providerId: {
      type: Schema.Types.ObjectId,
      ref: 'provider',
      required: [true, 'El proveedor es obligatorio']
    },
    version: {
      type: String,
      required: [true, 'La versión es obligatoria']
    },
    reason: {
      type: String,
      enum: Object.values(CatalogVersionReason),
      required: [true, 'La razón del cambio es obligatoria']
    },
    triggeredBy: {
      type: Schema.Types.ObjectId,
      ref: 'user'
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

// Índice único: solo una versión por proveedor
CatalogVersionSchema.index(
  { providerId: 1 },
  { unique: true, name: 'idx_unique_provider' }
)

const CatalogVersionModel = model<ICatalogVersion>('catalogVersion', CatalogVersionSchema)
export default CatalogVersionModel
