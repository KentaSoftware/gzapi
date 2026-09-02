import { NextFunction, Request, Response } from 'express'
import { verifyToken } from '../utils/jwt.handle'
import { JwtPayload } from 'jsonwebtoken'
import mongoose from 'mongoose'

interface RequestExt extends Request {
  user?: string | JwtPayload
}

const checkJwt = async (req: RequestExt, res: Response, next: NextFunction): Promise<void> => {
  try {
    console.log('🔐 [checkJwt] Headers recibidos:', JSON.stringify(req.headers, null, 2))
    
    // Verificar estado de conexión a MongoDB
    if (mongoose.connection.readyState !== 1) {
      console.warn('❌ [checkJwt] MongoDB no conectado. Estado:', mongoose.connection.readyState)
      res.status(503)
      res.send('BASE_DE_DATOS_NO_DISPONIBLE')
      return
    }

    const jwtByUser = req.headers.authorization
    console.log('🔑 [checkJwt] Authorization header:', jwtByUser?.substring(0, 50) + '...')
    
    const jwt = jwtByUser?.split(' ').pop()
    console.log('🎫 [checkJwt] Token extraído (primeros 30 chars):', jwt?.substring(0, 30))
    
    const isUser = await verifyToken(`${jwt ?? ''}`)
    console.log('👤 [checkJwt] Usuario decodificado:', JSON.stringify(isUser, null, 2))
    
    const isOk = Boolean(isUser)
    if (!isOk) {
      console.log('❌ [checkJwt] Token inválido o usuario no encontrado')
      res.status(401)
      res.send('NO_TIENES_UN_JWT_VALIDO')
    } else {
      console.log('✅ [checkJwt] Token válido, asignando req.user')
      req.user = isUser
      next()
    }
  } catch (e: any) {
    console.error('❌ [checkJwt] Error en verificación:', e.message)
    console.error('❌ [checkJwt] Stack:', e.stack)
    res.status(400)
    res.send('SESSION_NO_VALIDA')
  }
}

export { checkJwt }
