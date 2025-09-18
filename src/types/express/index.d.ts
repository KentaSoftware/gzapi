import 'express'
import 'pino-http'

declare module 'express-serve-static-core' {
  interface Request {
    user?: { id: string; role?: any; [k: string]: any }
  }
}


