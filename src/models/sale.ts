import { Schema, model } from 'mongoose'
import { SALE_DELIVERY_STATUS, Sale, SaleDelivery } from '../interfaces/sale.interface'

const SaleDeliverySchema = new Schema<SaleDelivery>(
  {
    status: {
      type: String,
      enum: Object.values(SALE_DELIVERY_STATUS),
      required: true
    },
    serviceDate: {
      type: Date,
      required: function (this: SaleDelivery): boolean {
        return this.status === SALE_DELIVERY_STATUS.PENDING
      }
    },
    deliveredAt: {
      type: Date,
      required: function (this: SaleDelivery): boolean {
        return this.status === SALE_DELIVERY_STATUS.DELIVERED
      }
    },
    notes: {
      type: String,
      trim: true
    }
  },
  { _id: false }
)

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
    },
    paidAt: {
      type: Date,
      required: false
    },
    delivery: {
      type: SaleDeliverySchema,
      required: false
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
)

SaleSchema.pre('validate', function (next) {
  if (this.delivery?.status === SALE_DELIVERY_STATUS.PENDING && this.idCliente == null) {
    this.invalidate('delivery', 'PENDING delivery requires idCliente')
  }
  next()
})

const SaleModel = model('sale', SaleSchema)
export default SaleModel
