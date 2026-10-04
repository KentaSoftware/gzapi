import { Schema, model } from 'mongoose'
import { Client } from '../interfaces/client.interface'

const ClientSchema = new Schema<Client>(
  {
    nombreCompleto: {
      type: String,
      require: true
    },
    address: {
      type: String
    },
    telefonos: {
      type: [
        Number
      ]
    },
    lat: {
      type: Number
    },
    lng: {
      type: Number
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
)

const ClientModel = model('client', ClientSchema)
export default ClientModel
