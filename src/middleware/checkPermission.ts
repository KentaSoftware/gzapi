import { NextFunction, Request, Response } from 'express'
import { JwtPayload } from 'jsonwebtoken'
import UserModel from '../models/user'
import mongoose from 'mongoose'
import { sendErrorEnvelope } from '../utils/error.handle'

interface UserRole {
  permissions?: string[]
}

interface AuthenticatedUser extends JwtPayload {
  id?: string
  role?: UserRole
}

interface RequestExt extends Request {
  user?: string | AuthenticatedUser
}

const checkPermission = (action: string) => {
  return async (req: RequestExt, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (mongoose.connection.readyState !== 1) {
        console.warn(JSON.stringify({ event: 'authorization_unavailable', correlationId: res.locals.correlationId }))
        sendErrorEnvelope(res, 503, 'DATABASE_UNAVAILABLE', 'Authorization service is unavailable')
        return
      }

      const user = typeof req.user === 'string' ? undefined : req.user

      if (user === undefined || user.role === undefined || user.role.permissions === undefined) {
        console.warn(JSON.stringify({ event: 'authorization_denied', correlationId: res.locals.correlationId, reason: 'missing_permissions' }))
        sendErrorEnvelope(res, 403, 'PERMISSION_DENIED', 'Permission is denied')
        return
      }

      const hasPermission = user.role.permissions.includes(action)

      if (!hasPermission) {
        console.warn(JSON.stringify({ event: 'authorization_denied', correlationId: res.locals.correlationId, reason: 'missing_permission' }))
        sendErrorEnvelope(res, 403, 'PERMISSION_DENIED', 'Permission is denied')
        return
      }

      res.locals.userId = user.id

      const usuarioDB = await UserModel.findById(user.id)
        .maxTimeMS(5000) // Timeout de 5 segundos para la query
        .lean()

      if (usuarioDB === null || usuarioDB === undefined || !usuarioDB.isActive) {
        console.warn(JSON.stringify({ event: 'authorization_denied', correlationId: res.locals.correlationId, reason: 'inactive_user' }))
        sendErrorEnvelope(res, 403, 'PERMISSION_DENIED', 'Permission is denied')
        return
      }

      next()
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : ''
      if (errorName === 'MongooseError' || errorName === 'MongoError') {
        console.warn(JSON.stringify({ event: 'authorization_unavailable', correlationId: res.locals.correlationId }))
        sendErrorEnvelope(res, 503, 'DATABASE_UNAVAILABLE', 'Authorization service is unavailable')
      } else {
        console.warn(JSON.stringify({ event: 'authorization_denied', correlationId: res.locals.correlationId, reason: 'verification_failed' }))
        sendErrorEnvelope(res, 403, 'PERMISSION_DENIED', 'Permission is denied')
      }
    }
  }
}

export { checkPermission }
