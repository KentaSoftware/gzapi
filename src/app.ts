import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { router } from './routes'
import db from './config/mongo'
import { init } from './socket'
import path from 'path'
import { seedDatabase } from './services/seed'
import pinoHttp from 'pino-http'
import { v4 as uuidv4 } from 'uuid'
import { logger } from './lib/logger'
import { ensureLogTTL } from './config/log-ttl'

const PORT = process.env.PORT ?? 3002
const app = express()

app.use(cors())
app.use('/image', express.static(path.join(__dirname, '..', '/public')))
console.log(path.join(__dirname, '..', '/public'))
app.use(express.json())

function mapCrud (method: string): 'C' | 'R' | 'U' | 'D' {
  switch (method) {
    case 'POST': return 'C'
    case 'GET': return 'R'
    case 'PUT':
    case 'PATCH': return 'U'
    case 'DELETE': return 'D'
    default: return 'R'
  }
}

function deriveCollection (req: any): string | undefined {
  const base = (req.baseUrl || '').replace(/^\//, '')
  if (base) return base
  const seg = (req.path || req.originalUrl || '').split('?')[0].split('/').filter(Boolean)
  return seg[0]
}
function deriveDocId (req: any): string | undefined {
  return req.params?.id || undefined
}

app.use(pinoHttp({
  logger,
  genReqId: (req) => (req.headers['x-request-id'] as string) || uuidv4(),
  customProps: (req, _res) => {
    const collection = deriveCollection(req)
    const docId = deriveDocId(req)
    return {
      requestId: (req as any).id,
      userId: (req as any).user?.id,
      collection,
      action: mapCrud(req.method),
      docId,
      ip: req.ip
    }
  },
  serializers: {
    req (req) { return { method: req.method, url: req.url } },
    res (res) { return { statusCode: res.statusCode } },
    err (err) { return { type: err.name, msg: err.message, stack: err.stack } }
  },
  quietReqLogger: true
}))
app.use(router)

db().then(async () => {
  logger.info('Conexion lista')
  await seedDatabase()
  logger.info('✅ Database seeded')
  ensureLogTTL().catch(err => logger.warn({ err }, 'ensureLogTTL failed'))
}).catch((e) => logger.error({ err: e }, 'Ocurrio un error en la conexion con la bd'))

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Listening...')
  const io = init(server)
  io.on('connection', () => {
    logger.info('Client connected!')
  })
})

// Manejador de errores al final
// eslint-disable-next-line @typescript-eslint/no-misused-promises
app.use((err: any, req: any, res: any, _next: any) => {
  req.log?.error({ err }, 'Unhandled route error')
  res.status(err?.status || 500).json({
    error: 'internal_error',
    requestId: req.id
  })
})
