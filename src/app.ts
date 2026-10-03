import 'dotenv/config'
import express, { Express } from 'express'
import cors from 'cors'
import path from 'path'
import { loadRoutes } from './routes/index'
import { requestLogger } from './middleware/requestLogger'

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
  console.log(publicDirectory)
  app.use(express.json())

  // Middleware de logging para todas las requests
  app.use(requestLogger)

  const router = await loadRoutes()
  app.use(router)

  return app
}

export { createApp }
