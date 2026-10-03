import { Response } from 'express'

interface ErrorEnvelope {
  code: string
  message: string
  correlationId?: string
}

const handleHttp = (res: Response, error: string, _?: any): void => {
  res.status(500)
  res.send({ error })
}

const sendErrorEnvelope = (res: Response, status: number, code: string, message: string, correlationId?: string): void => {
  const envelope: ErrorEnvelope = { code, message }
  if (correlationId !== undefined) {
    envelope.correlationId = correlationId
  }
  res.status(status)
  res.send(envelope)
}

export { handleHttp, sendErrorEnvelope }
export type { ErrorEnvelope }
