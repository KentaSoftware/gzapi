import { Request, Response } from 'express'
import mongoose from 'mongoose'

export const healthCheck = (_req: Request, res: Response): void => {
  const mongoStatus = mongoose.connection.readyState
  const mongoStates: Record<number, string> = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting'
  }

  const health = {
    status: mongoStatus === 1 ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    mongodb: {
      status: mongoStates[mongoStatus] ?? 'unknown',
      readyState: mongoStatus
    },
    memory: {
      rss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
    }
  }

  const statusCode = mongoStatus === 1 ? 200 : 503
  res.status(statusCode).json(health)
}
