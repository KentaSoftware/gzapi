import { Schema, model } from 'mongoose'
import { Buy } from '../interfaces/buy.interface'

const BuySchema = new Schema<Buy>(
  {
    estado: {
      type: String,
      required: true
    },
    total: {
      type: Number,
      required: true
    },
    user: {
      type: Schema.ObjectId,
      ref: 'User',
      required: true
    },
    proveedor: {
      type: String
    },
    fecha: {
      type: Date,
      required: false
    },
    docNumber: {
      type: String,
      required: false
    },
    fingerprint: {
      type: String,
      required: false
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
)

// Índices para detección de duplicados
BuySchema.index({ proveedor: 1, fecha: 1, total: 1 })
BuySchema.index({ proveedor: 1, docNumber: 1 }, { sparse: true })
BuySchema.index({ proveedor: 1, fingerprint: 1 }, { sparse: true })

const BuyModel = model('buy', BuySchema)
export default BuyModel
