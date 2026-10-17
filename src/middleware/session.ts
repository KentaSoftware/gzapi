import { NextFunction, Request, Response } from 'express'
import { verifyToken } from '../utils/jwt.handle'
import { JwtPayload } from 'jsonwebtoken'
import mongoose from 'mongoose'
import { sendErrorEnvelope } from '../utils/error.handle'

interface RequestExt extends Request {
  user?: string | JwtPayload
}

const checkJwt = async (req: RequestExt, res: Response, next: NextFunction): Promise<void> => {
  if (mongoose.connection.readyState !== 1) {
    console.warn(JSON.stringify({ event: 'authentication_unavailable', correlationId: res.locals.correlationId }))
    sendErrorEnvelope(res, 503, 'DATABASE_UNAVAILABLE', 'Authentication service is unavailable')
    return
  }

  const authorization = req.headers.authorization
  const token = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : ''

  if (token === '') {
    console.warn(JSON.stringify({ event: 'authentication_rejected', correlationId: res.locals.correlationId, reason: 'missing_token' }))
    sendErrorEnvelope(res, 401, 'AUTHENTICATION_INVALID', 'Authentication credentials are invalid')
    return
  }

  try {
    const user = await verifyToken(token)
    if (typeof user === 'string') {
      console.warn(JSON.stringify({ event: 'authentication_rejected', correlationId: res.locals.correlationId, reason: 'invalid_token' }))
      sendErrorEnvelope(res, 401, 'AUTHENTICATION_INVALID', 'Authentication credentials are invalid')
      return
    }
    req.user = user
    next()
  } catch {
    console.warn(JSON.stringify({ event: 'authentication_rejected', correlationId: res.locals.correlationId, reason: 'invalid_token' }))
    sendErrorEnvelope(res, 401, 'AUTHENTICATION_INVALID', 'Authentication credentials are invalid')
  }
}

export { checkJwt }
