import { NextFunction, Request, Response } from 'express'
import { verifyToken } from '../utils/jwt.handle'
import { JwtPayload } from 'jsonwebtoken'

interface RequestExt extends Request {
  user?: string | JwtPayload
}

const checkJwt = async (req: RequestExt, res: Response, next: NextFunction): Promise<void> => {
  try {

    const jwtByUser = req.headers.authorization
    const jwt = jwtByUser?.split(' ').pop()
    const isUser = await verifyToken(`${jwt ?? ''}`)
    const isOk = Boolean(isUser)
    if (!isOk) {
      res.status(401)
      res.send('NO_TIENES_UN_JWT_VALIDO')
    } else {
      req.user = isUser
      next()
    }
  } catch (e) {
    res.status(400)
    res.send('SESSION_NO_VALIDA')
  }
}

export { checkJwt }
