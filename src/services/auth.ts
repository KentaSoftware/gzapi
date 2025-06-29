import { Auth, AuthWithToken } from '../interfaces/auth.interface'
import UserModel from '../models/user'
import { encrypt, verified } from '../utils/bcrypt.handle'
import { generateToken } from '../utils/jwt.handle'
import _ from 'lodash'
import { User } from '../interfaces/auth.interface'

const registerNewUser = async ({ nickname, password, role, nameRole }: Partial<User>): Promise<Auth | string> => {
  const checkIs = await UserModel.findOne({ nickname })
  if (checkIs !== null) return 'ALREADY_USER'
  const passHash = await encrypt(password as string)
  const registerNewUser: any = await UserModel.create({
    nickname,
    password: passHash,
    role: role ? role : '',
    isActive: true
  })
  const user = { ...registerNewUser._doc, password: undefined, nameRole: nameRole, role: role }
  return user
}

const loginUser = async ({ nickname, password }: Auth): Promise<Partial<AuthWithToken> | string> => {
  const checkIs = await UserModel.findOne({ nickname: new RegExp(`^${nickname}$`, 'i') }).populate('role')
  if (checkIs == null) return 'NOT_FOUND_USER'
  const passwordHash = checkIs.password
  const isCorrect = await verified(password, passwordHash)
  if (!isCorrect) return 'PASSWORD_INCORRECT'
  const token = await generateToken(checkIs)
  const data = { nickname: checkIs.nickname, token, nameRole: checkIs.role.name }
  return data
}

export { registerNewUser, loginUser }
