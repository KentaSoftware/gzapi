import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { router } from './routes'
import db from './config/mongo'
import { init } from './socket'
import path from 'path'
import { seedDatabase } from './services/seed'
import { requestLogger } from './middleware/requestLogger'

const PORT = process.env.PORT ?? 3002
const app = express()

app.use(cors())
app.use('/image', express.static(path.join(__dirname, '..', '/public')))
console.log(path.join(__dirname, '..', '/public'))
app.use(express.json())

// Middleware de logging para todas las requests
app.use(requestLogger)

app.use(router)

db().then(async () => {
  console.log('Conexion lista')
  try {
    await seedDatabase();
    console.log('✅ Database seeded');
  } catch (seedError: any) {
    console.warn('⚠️ Error durante seed (no es crítico):', seedError?.message || seedError);
  }
}
).catch((e: any) => {
  console.error('Ocurrio un error en la conexion con la bd', e);
  process.exit(1);
})

const server = app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}...`)
  const io = init(server)
  io.on('connection', () => {
    console.log('Client connected!')
  })
})
