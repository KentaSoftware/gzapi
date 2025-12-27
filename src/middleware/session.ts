import { NextFunction, Request, Response } from 'express'
import { verifyToken } from '../utils/jwt.handle'
import { JwtPayload } from 'jsonwebtoken'
import mongoose from 'mongoose'

interface RequestExt extends Request {
  user?: string | JwtPayload
}

const checkJwt = async (req: RequestExt, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Verificar estado de conexión a MongoDB
    if (mongoose.connection.readyState !== 1) {
      console.warn('MongoDB no conectado. Estado:', mongoose.connection.readyState)
      res.status(503)
      res.send('BASE_DE_DATOS_NO_DISPONIBLE')
      return
    }

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
