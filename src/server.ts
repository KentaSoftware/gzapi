import 'dotenv/config'
import type { Server } from 'http'
import { createApp } from './app'
import db from './config/mongo'
import { seedDatabase } from './services/seed'
import { init } from './socket'

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
    const io = init(server)
    io.on('connection', () => {
      console.log('Client connected!')
    })
  })

  return server
}

export { startServer }
