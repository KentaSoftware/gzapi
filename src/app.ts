import 'dotenv/config'
import express, { Express } from 'express'
import cors from 'cors'
import path from 'path'
import { loadRoutes } from './routes/index'
import { requestLogger } from './middleware/requestLogger'
import { correlationId } from './middleware/correlationId'

// Under CommonJS the public directory sits next to the compiled/source root.
// The native ES module loader used by the test runner has no `__dirname`, so
// fall back to the process CWD, which is the repository root for every npm script.
const publicDirectory = typeof __dirname === 'string'
  ? path.join(__dirname, '..', 'public')
  : path.join(process.cwd(), 'public')

const createApp = async (): Promise<Express> => {
  const app = express()

  app.use(cors())
  app.use('/image', express.static(publicDirectory))
  app.use(express.json())
  app.use(correlationId)
  app.use(requestLogger)

  const router = await loadRoutes()
  app.use(router)

  return app
}

export { createApp }
