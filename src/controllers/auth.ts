import { Request, Response } from 'express'
import { handleHttp, sendErrorEnvelope } from '../utils/error.handle'
import { registerNewUser, loginUser, getCurrentSession } from '../services/auth'
import { JwtPayload } from 'jsonwebtoken'
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

interface SessionRequest extends Request {
  user?: string | JwtPayload
}

const currentSessionCtrl = async (req: SessionRequest, res: Response): Promise<void> => {
  const id = typeof req.user === 'object' && req.user !== null ? req.user.id : undefined
  if (typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id)) {
    sendErrorEnvelope(res, 401, 'AUTHENTICATION_INVALID', 'Authentication credentials are invalid')
    return
  }
  try {
    const session = await getCurrentSession(id)
    if (session === null) {
      sendErrorEnvelope(res, 403, 'PERMISSION_DENIED', 'Permission is denied')
      return
    }
    res.send(session)
  } catch {
    sendErrorEnvelope(res, 503, 'DATABASE_UNAVAILABLE', 'Authentication service is unavailable')
  }
}

export { registerCtrl, loginCtrl, currentSessionCtrl }
