import { Schema, model } from 'mongoose'
import { Sale } from '../interfaces/sale.interface'
import versioned from 'mongoose-versioned'
import { attachUpdatedBy } from './hooks/versioned-metadata'

const SaleSchema = new Schema<Sale>(
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
    cliente: {
      type: String
    },
    porcentaje: {
      type: Number
    },
    idCliente: {
      type: Schema.ObjectId,
      ref: 'Client'
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
)

SaleSchema.add({ updatedBy: { type: String, required: false } })
SaleSchema.plugin(versioned, { collection: 'sale_versions' as any })
attachUpdatedBy(SaleSchema)

const SaleModel = model('sale', SaleSchema)
export default SaleModel
