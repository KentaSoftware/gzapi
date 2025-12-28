import { Request, Response, NextFunction } from 'express'
import { JwtPayload } from 'jsonwebtoken'

interface RequestExt extends Request {
  user?: string | JwtPayload | any
}

/**
 * Middleware de logging para todas las requests HTTP
 * Registra: método, ruta, usuario, parámetros, tiempo de ejecución y resultado
 */
export const requestLogger = (req: RequestExt, res: Response, next: NextFunction): void => {
  const startTime = Date.now()
  const { method, originalUrl, query, body } = req
  const userId = req.user?.id || 'anonymous'

  // Filtrar datos sensibles del body
  const sanitizedBody = { ...body }
  if (sanitizedBody.password) sanitizedBody.password = '***'
  if (sanitizedBody.token) sanitizedBody.token = '***'

  // Log de inicio del request
  const hasQuery = Object.keys(query).length > 0
  const hasBody = Object.keys(sanitizedBody).length > 0 && method !== 'GET'
  
  let logMsg = `[${method}] ${originalUrl}`
  
  if (userId !== 'anonymous') {
    logMsg += ` | User: ${userId}`
  }

  if (hasQuery) {
    const queryStr = JSON.stringify(query)
    if (queryStr.length < 100) {
      logMsg += ` | Query: ${queryStr}`
    } else {
      logMsg += ` | Query: ${queryStr.substring(0, 97)}...`
    }
  }

  if (hasBody) {
    const bodyStr = JSON.stringify(sanitizedBody)
    if (bodyStr.length < 100) {
      logMsg += ` | Body: ${bodyStr}`
    } else {
      logMsg += ` | Body: ${bodyStr.substring(0, 97)}...`
    }
  }

  console.log(`\n🔵 ${logMsg}`)

  // Interceptar el res.json() para loguear la respuesta
  const originalJson = res.json.bind(res)
  res.json = function (body: any) {
    const elapsed = Date.now() - startTime
    const statusCode = res.statusCode

    // Determinar el emoji según el status code
    let emoji = '✅'
    if (statusCode >= 500) emoji = '❌'
    else if (statusCode >= 400) emoji = '⚠️'
    else if (statusCode === 304) emoji = '🔄'
    else if (statusCode >= 300) emoji = '↪️'

    console.log(`${emoji} [${method}] ${originalUrl} | Status: ${statusCode} | Time: ${elapsed}ms`)

    // Llamar al método original
    return originalJson(body)
  }

  // Interceptar el res.send() para requests que no usen json
  const originalSend = res.send.bind(res)
  res.send = function (body: any) {
    const elapsed = Date.now() - startTime
    const statusCode = res.statusCode

    let emoji = '✅'
    if (statusCode >= 500) emoji = '❌'
    else if (statusCode >= 400) emoji = '⚠️'
    else if (statusCode === 304) emoji = '🔄'
    else if (statusCode >= 300) emoji = '↪️'

    console.log(`${emoji} [${method}] ${originalUrl} | Status: ${statusCode} | Time: ${elapsed}ms`)

    return originalSend(body)
  }

  next()
}
