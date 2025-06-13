import { Auth, AuthWithToken } from '../interfaces/auth.interface'
import UserModel from '../models/user'
import { encrypt, verified } from '../utils/bcrypt.handle'
import { generateToken } from '../utils/jwt.handle'
import _ from 'lodash'

const registerNewUser = async ({ nickname, password }: Auth): Promise<Auth | string> => {
  const checkIs = await UserModel.findOne({ nickname })
  if (checkIs !== null) return 'ALREADY_USER'
  const passHash = await encrypt(password)
  const registerNewUser = await UserModel.create({ nickname, password: passHash })
  return registerNewUser
}

const loginUser = async ({ nickname, password }: Auth): Promise<AuthWithToken | string> => {
  const checkIs = await UserModel.findOne({ nickname: new RegExp(`^${nickname}$`, 'i') })
  if (checkIs == null) return 'NOT_FOUND_USER'
  const passwordHash = checkIs.password
  const isCorrect = await verified(password, passwordHash)
  if (!isCorrect) return 'PASSWORD_INCORRECT'
  const token = await generateToken(checkIs)
  const data = { nickname: checkIs.nickname, token }
  return data
}

export { registerNewUser, loginUser }
