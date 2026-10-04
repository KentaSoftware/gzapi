import { Schema, model } from 'mongoose'
import { Provider } from '../interfaces/product.interface'

const ProviderSchema = new Schema<Provider>(
  {
    descripcion: {
      type: String,
      require: true
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
)

const ProviderModel = model('provider', ProviderSchema)
export default ProviderModel
