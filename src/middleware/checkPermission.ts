import { NextFunction, Request, Response } from 'express'
import { JwtPayload } from 'jsonwebtoken'
import UserModel from '../models/user'

interface RequestExt extends Request {
  user?: string | JwtPayload | any
}

const checkPermission = (action: string) => {
  return async (req: RequestExt, res: Response, next: NextFunction): Promise<void> => {
    try {
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

      // Agregar datos útiles al ciclo de request
      res.locals.userId = user.id
      res.locals.permission = action

      const usuarioDB = await UserModel.findById(user.id);

      if (!usuarioDB || usuarioDB.isActive !== true) {
        res.status(403);
        res.send('USUARIO_NO_ACTIVO');
        return;
      }

      next()
    } catch (e) {
      console.error('Error checking permissions:', e)
      res.status(403)
      res.send('ERROR_VERIFICANDO_PERMISOS')
    }
  }
}

export { checkPermission } 