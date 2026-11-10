import { Auth, AuthWithToken, User } from '../interfaces/auth.interface'
import UserModel from '../models/user'
import RoleModel from '../models/role'
import { encrypt, verified } from '../utils/bcrypt.handle'
import { generateToken } from '../utils/jwt.handle'

const registerNewUser = async ({ nickname, password, role, nameRole }: Partial<User>): Promise<Auth | string> => {
  const checkIs = await UserModel.findOne({ nickname })
  if (checkIs !== null) return 'ALREADY_USER'
  const passHash = await encrypt(password as string)
  const registerNewUser: any = await UserModel.create({
    nickname,
    password: passHash,
    role: (role != null) ? role : '',
    isActive: true
  })
  const user = { ...registerNewUser._doc, password: undefined, nameRole, role }
  return user
}

const loginUser = async ({ nickname, password }: Auth): Promise<Partial<AuthWithToken> | string> => {
  const checkIs = await UserModel.findOne({ nickname: new RegExp(`^${nickname}$`, 'i') }).populate('role')
  if (checkIs == null) return 'NOT_FOUND_USER'
  const passwordHash = checkIs.password
  const isCorrect = await verified(password, passwordHash)
  if (!isCorrect) return 'PASSWORD_INCORRECT'
  if (!checkIs.isActive) return 'USUARIO_NO_ACTIVO'
  const token = await generateToken(checkIs)
  const data = { nickname: checkIs.nickname, token, nameRole: checkIs.role.name }
  return data
}

interface CurrentRole {
  id: string
  name: string
}

interface CurrentSession {
  id: string
  nickname: string
  role: CurrentRole
  permissions: string[]
  isAdmin: boolean
}

const getCurrentSession = async (id: string): Promise<CurrentSession | null> => {
  const user = await UserModel.findById(id).select('nickname role isActive').maxTimeMS(5000).lean()
  if (user == null || !user.isActive || user.role == null) return null

  const role = await RoleModel.findById(user.role).select('name permissions isActive').maxTimeMS(5000).lean()
  if (role == null || !role.isActive) return null

  return {
    id: user._id.toString(),
    nickname: user.nickname,
    role: { id: role._id.toString(), name: role.name },
    permissions: role.permissions ?? [],
    isAdmin: role.name === 'admin'
  }
}

export { registerNewUser, loginUser, getCurrentSession }
