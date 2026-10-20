import 'dotenv/config'
import type { Server } from 'http'
import { createApp } from './app'
import db from './config/mongo'
import { seedDatabase } from './services/seed'

const PORT = process.env.PORT ?? 3002

const startServer = async (): Promise<Server> => {
  const app = await createApp()

  await db()
  console.log('Conexion lista')

  try {
    await seedDatabase()
    console.log('✅ Database seeded')
  } catch (seedError) {
    const message = seedError instanceof Error ? seedError.message : String(seedError)
    console.warn('⚠️ Error durante seed (no es crítico):', message)
  }

  const server = app.listen(PORT, () => {
    console.log(`Listening on port ${PORT}...`)
  })

  return server
}

// Invoke the server only when this module runs as the process entry point
// (nodemon dev script or the compiled dist/server.js start script); importing
// the module from tests or other code must not open any listener.
if (typeof require !== 'undefined' && require.main === module) {
  void startServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error('Server startup failed:', message)
    process.exit(1)
  })
}

export { startServer }
