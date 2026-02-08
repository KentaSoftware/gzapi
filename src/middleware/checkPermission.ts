import { NextFunction, Request, Response } from 'express'
import { JwtPayload } from 'jsonwebtoken'
import UserModel from '../models/user'
import mongoose from 'mongoose'

interface RequestExt extends Request {
  user?: string | JwtPayload | any
}

const checkPermission = (action: string) => {
  return async (req: RequestExt, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Verificar estado de conexión a MongoDB
      if (mongoose.connection.readyState !== 1) {
        console.error('MongoDB no conectado. Estado:', mongoose.connection.readyState)
        res.status(503)
        res.send('BASE_DE_DATOS_NO_DISPONIBLE')
        return
      }

      const user = req.user as any

      if (!user || !user.role || !user.role.permissions) {
        res.status(403)
        res.send('TOKEN_NO_VALIDO_O_SIN_PERMISOS')
        return
      }

      // Verificar si el usuario tiene el permiso específico
      const hasPermission = user.role.permissions.includes(action)

      if (!hasPermission) {
        res.status(403)
        res.send('PERMISO_NO_ENCONTRADO')
        return
      }

      // Agregar el ID del usuario a la respuesta
      res.locals.userId = user.id

      const usuarioDB = await UserModel.findById(user.id)
        .maxTimeMS(5000) // Timeout de 5 segundos para la query
        .lean()

      if (!usuarioDB || usuarioDB.isActive !== true) {
        res.status(403)
        res.send('USUARIO_NO_ACTIVO')
        return
      }

      next()
    } catch (e: any) {
      console.error('Error checking permissions:', e.message)
      
      if (e.name === 'MongooseError' || e.name === 'MongoError') {
        res.status(503)
        res.send('ERROR_BASE_DE_DATOS')
      } else {
        res.status(403)
        res.send('ERROR_VERIFICANDO_PERMISOS')
      }
    }
  }
}

export { checkPermission } 