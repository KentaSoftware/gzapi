import { Schema, model } from 'mongoose'
import { Log } from '../interfaces/log.interface'

const LogSchema = new Schema<Log>(
  {
    accion: {
      type: String,
      require: true
    },
    coleccion: {
      type: String,
      require: true
    },
    idColeccion: {
      type: Schema.ObjectId,
      required: true
    },
    userId: {
      type: Schema.ObjectId,
      ref: 'user'
    },
    changedFields: {
      type: Schema.Types.Mixed
    },
    metadata: {
      type: Schema.Types.Mixed
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
)

const LogModel = model('log', LogSchema)
export default LogModel
