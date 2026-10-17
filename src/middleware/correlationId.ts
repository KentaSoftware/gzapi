import { NextFunction, Request, Response } from 'express'
import { randomUUID } from 'crypto'

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

const suppliedCorrelationId = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' && CORRELATION_ID_PATTERN.test(value) ? value : undefined

const correlationId = (req: Request, res: Response, next: NextFunction): void => {
  const value = suppliedCorrelationId(req.headers['x-correlation-id']) ?? randomUUID()
  req.headers['x-correlation-id'] = value
  res.locals.correlationId = value
  res.setHeader('x-correlation-id', value)
  next()
}

export { correlationId }
