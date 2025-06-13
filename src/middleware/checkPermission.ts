import { NextFunction, Request, Response } from 'express'
import { JwtPayload } from 'jsonwebtoken'

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

      // Agregar el ID del usuario a la respuesta
      res.locals.userId = user.id
      next()
    } catch (e) {
      console.error('Error checking permissions:', e)
      res.status(403)
      res.send('ERROR_VERIFICANDO_PERMISOS')
    }
  }
}

export { checkPermission } 