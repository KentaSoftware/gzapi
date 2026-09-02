import { Schema, model } from 'mongoose'
import { Role } from '../interfaces/auth.interface'


const RoleSchema = new Schema<Role>(
  {
    name: {
      type: String,
      required: true,
      unique: true
    },
    description: {
      type: String
    },
    permissions: [String],
    isActive: {
      type: Boolean,
      default: true
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
)

const RoleModel = model('role', RoleSchema)
export default RoleModel 