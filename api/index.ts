import type { Express, Request, Response } from 'express'
import { createApp } from '../src/app'
import dbConnect from '../src/config/mongo'
import { seedDatabase } from '../src/services/seed'
import { runProductionStartupSeed } from '../migrations/demo-002-build-seed'

export interface InitializationDependencies {
  connect: () => Promise<void>
  seed: () => Promise<void>
  seedDemo: () => Promise<unknown>
  createApp: () => Promise<Express>
}

type VercelHandler = (req: Request, res: Response) => Promise<void>

// Operator-facing diagnosis: the message only, with secrets and connection strings redacted.
const describeInitializationError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : 'non-Error failure'
  return message
    .replace(/mongodb(?:\+srv)?:\/\/\S+/gi, '[redacted MongoDB target]')
    .replace(/AIza[\w-]{20,}/g, '[redacted Google key]')
}

export function createVercelHandler (dependencies: InitializationDependencies): VercelHandler {
  let initialization: Promise<Express> | undefined

  const initialize = async (): Promise<Express> => {
    await dependencies.connect()
    await dependencies.seed()
    await dependencies.seedDemo()
    return await dependencies.createApp()
  }

  return async (req: Request, res: Response): Promise<void> => {
    if (initialization === undefined) initialization = initialize()

    try {
      const app = await initialization
      app(req, res)
    } catch (error) {
      initialization = undefined
      console.error('Vercel REST application initialization failed:', describeInitializationError(error))
      res.status(500).json({ error: 'Service initialization failed' })
    }
  }
}

const handler = createVercelHandler({
  connect: dbConnect,
  seed: seedDatabase,
  seedDemo: runProductionStartupSeed,
  createApp
})

export default handler
