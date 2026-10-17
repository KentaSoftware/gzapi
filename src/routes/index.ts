import { Router } from 'express'
import { readdirSync } from 'fs'
import path from 'path'

// Under CommonJS (ts-node / compiled build) the routes live next to this file.
// The native ES module loader used by the test runner has no `__dirname`, so
// fall back to the source routes directory relative to the process CWD.
const routesDirectory = typeof __dirname === 'string'
  ? __dirname
  : path.join(process.cwd(), 'src', 'routes')

const cleanFileName = (fileName: string): string => {
  const file = fileName.split('.').shift()
  return file ?? ''
}

const loadRouteModule = async (name: string): Promise<any> => {
  try {
    return await import(`./${name}`)
  } catch (error) {
    // The native ESM loader requires an explicit extension; CommonJS resolves
    // the extensionless form directly.
    return await import(`./${name}.ts`)
  }
}

const loadRoutes = async (): Promise<Router> => {
  const router = Router()

  const routeNames = [...new Set(
    readdirSync(routesDirectory)
      .map(cleanFileName)
      .filter((name) => name !== '' && name !== 'index')
  )]

  await Promise.all(
    routeNames.map(async (name) => {
      try {
        const moduleRouter = await loadRouteModule(name)
        router.use(`/${name}`, moduleRouter.router)
      } catch (error) {
        console.log('Ocurrio un error en la ruta', error)
      }
    })
  )

  return router
}

export { loadRoutes }
