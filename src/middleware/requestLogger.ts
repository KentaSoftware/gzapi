import { Request, Response, NextFunction } from 'express'

export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  const startTime = Date.now()
  const path = req.path

  res.on('finish', () => {
    console.log(JSON.stringify({
      event: 'http_request_completed',
      correlationId: res.locals.correlationId,
      method: req.method,
      path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startTime
    }))
  })

  next()
}
