/* import { Schema, model } from 'mongoose'
import { Auth } from '../interfaces/auth.interface'

const UserSchema = new Schema<Auth>(
  {
    password: {
      type: String,
      required: true
    },
    nickname: {
      type: String,
      required: true,
      unique: true
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
)

const UserModel = model('user', UserSchema)
export default UserModel
 */

import { Schema, model } from 'mongoose'
import { User } from '../interfaces/auth.interface'

const UserSchema = new Schema<User>(
  {
    nickname: {
      type: String,
      required: true,
      unique: true
    },
    email: {
      type: String,
      unique: true,
      sparse: true
    },
    password: {
      type: String,
      required: true
    },
    role: {
      type: Schema.Types.ObjectId,
      ref: 'role',
    },
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

const UserModel = model('user', UserSchema)
export default UserModel 