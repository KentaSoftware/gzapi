import { Schema, model } from 'mongoose'
import { Log } from '../interfaces/log.interface'

const LogSchema = new Schema<Log>(
  {
    accion: {
      type: String, // READ, CREATE, UPDATE, DELETE
      require: true
    },
    coleccion: {
      type: String, // NOMBRE DE LA COLECCION (SALE, CLIENT, PRODUCT, ETC)
      require: true
    },
    user: {
      type: Schema.ObjectId,
      required: true, // ID DEL USUARIO
      ref: 'user'
    },
    idColeccion: {
      type: Schema.ObjectId,
    },
    valueBefore: {
      type: Object, // EN EL CASO DE MODIFICACION
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
)

const LogModel = model('log', LogSchema)
export default LogModel
