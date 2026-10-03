import { Response } from 'express'

interface ErrorEnvelope {
  code: string
  message: string
  correlationId?: string
}

const handleHttp = (res: Response, error: string, _?: unknown): void => {
  res.status(500)
  res.send({ error })
}

const sendErrorEnvelope = (res: Response, status: number, code: string, message: string, correlationId?: string): void => {
  const envelope: ErrorEnvelope = { code, message }
  const requestCorrelationId = correlationId ?? res.locals.correlationId
  if (typeof requestCorrelationId === 'string') {
    envelope.correlationId = requestCorrelationId
  }
  res.status(status)
  res.send(envelope)
}

export { handleHttp, sendErrorEnvelope }
export type { ErrorEnvelope }
