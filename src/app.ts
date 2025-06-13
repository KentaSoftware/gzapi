import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { router } from './routes'
import db from './config/mongo'
import { init } from './socket'
import path from 'path'
import { seedDatabase } from './services/seed'

const PORT = process.env.PORT ?? 3002
const app = express()

app.use(cors())
app.use('/image', express.static(path.join(__dirname, '..', '/public')))
console.log(path.join(__dirname, '..', '/public'))
app.use(express.json())
app.use(router)

db().then(async () => {
  console.log('Conexion lista')
  await seedDatabase();
  console.log('✅ Database seeded');
}
).catch((e) => console.log('Ocurrio un error en la conexion con la bd', e))

const server = app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}...`)
  const io = init(server)
  io.on('connection', () => {
    console.log('Client connected!')
  })
})
