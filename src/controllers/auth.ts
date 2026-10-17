import { Request, Response } from 'express'
import { handleHttp } from '../utils/error.handle'
import { registerNewUser, loginUser } from '../services/auth'
import { emitSocket } from '../socket'
import { Types } from 'mongoose'

const registerCtrl = async ({ body }: Request, res: Response): Promise<void> => {
  try {
    const responseUser = await registerNewUser({ ...body, role: new Types.ObjectId(body.role) })
    emitSocket('user', {
      action: 'create',
      data: responseUser
    })
    res.send(responseUser)
  } catch (e) {
    handleHttp(res, 'ERROR_REGISTER_USER', e)
  }
}

const loginCtrl = async ({ body }: Request, res: Response): Promise<void> => {
  try {
    console.log(body)
    const responseUser = await loginUser(body)

    if (responseUser === 'USUARIO_NO_ACTIVO') {
      res.status(401)
      res.send(responseUser)
      return
    }

    if (responseUser === 'PASSWORD_INCORRECT') {
      res.status(403)
      res.send(responseUser)
    } else {
      res.send(responseUser)
    }
  } catch (e) {
    handleHttp(res, 'ERROR_LOGIN_USER', e)
  }
}

export { registerCtrl, loginCtrl }
