import { model, Schema } from 'mongoose'
import { City } from '../interfaces/client.interface'

const CitySchema = new Schema<City>(
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

const CityModel = model('city', CitySchema)
export default CityModel
