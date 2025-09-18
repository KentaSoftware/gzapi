import pino, { LoggerOptions, TransportMultiOptions } from 'pino'

const isProd = process.env.NODE_ENV === 'production'

const transportOptions: TransportMultiOptions = {
  targets: [
    {
      target: 'pino/file',
      options: { destination: 1 },
      level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug')
    },
    {
      target: 'pino-mongodb',
      level: process.env.LOG_LEVEL || 'info',
      options: {
        uri: process.env.LOG_MONGO_URI || process.env.MONGODB_URI,
        collection: process.env.LOG_COLLECTION || 'app_logs'
      }
    }
  ]
}

const options: LoggerOptions = {
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  mixin () {
    return {
      service: 'gzapi',
      env: process.env.NODE_ENV,
      ts: new Date()
    }
  }
}

export const logger = pino(options, pino.transport(transportOptions))


