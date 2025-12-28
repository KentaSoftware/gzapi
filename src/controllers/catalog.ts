import { Request, Response } from 'express'
import { JwtPayload } from 'jsonwebtoken'
import { handleHttp } from '../utils/error.handle'
import { isValidObjectId } from '../utils/normalize'
import {
  getCatalogVersionService,
  getCatalogSnapshotService,
  searchProductsService,
  getAllProvidersWithVersionService
} from '../services/catalog'

interface RequestExt extends Request {
  user?: string | JwtPayload | any
}

/**
 * GET /catalog/version?providerId=...
 * Obtiene la versión actual del catálogo de un proveedor
 */
export const getCatalogVersion = async (req: RequestExt, res: Response): Promise<void> => {
  try {
    const { providerId } = req.query

    if (!providerId || typeof providerId !== 'string') {
      res.status(400).json({
        error: 'PROVIDER_ID_REQUIRED',
        message: 'El parámetro providerId es obligatorio'
      })
      return
    }

    if (!isValidObjectId(providerId)) {
      res.status(400).json({
        error: 'INVALID_PROVIDER_ID',
        message: 'El providerId no tiene un formato válido'
      })
      return
    }

    const version = await getCatalogVersionService(providerId)
    res.json(version)
  } catch (e: any) {
    if (e.message === 'PROVIDER_NOT_FOUND') {
      res.status(404).json({
        error: 'PROVIDER_NOT_FOUND',
        message: 'Proveedor no encontrado'
      })
      return
    }
    handleHttp(res, 'ERROR_GET_CATALOG_VERSION', e)
  }
}

/**
 * GET /catalog/snapshot?providerId=...&limit=...&cursor=...&version=...
 * Obtiene snapshot liviano del catálogo paginado
 */
export const getCatalogSnapshot = async (req: RequestExt, res: Response): Promise<void> => {
  try {
    const { providerId, limit, cursor, version } = req.query

    if (!providerId || typeof providerId !== 'string') {
      res.status(400).json({
        error: 'PROVIDER_ID_REQUIRED',
        message: 'El parámetro providerId es obligatorio'
      })
      return
    }

    if (!isValidObjectId(providerId)) {
      res.status(400).json({
        error: 'INVALID_PROVIDER_ID',
        message: 'El providerId no tiene un formato válido'
      })
      return
    }

    // Validar cursor si viene
    if (cursor && typeof cursor === 'string' && !isValidObjectId(cursor)) {
      res.status(400).json({
        error: 'INVALID_CURSOR',
        message: 'El cursor no tiene un formato válido'
      })
      return
    }

    const parsedLimit = limit ? Math.min(Math.max(parseInt(limit as string, 10), 1), 1000) : 500

    // Obtener versión actual para comparar
    if (version && typeof version === 'string') {
      const currentVersion = await getCatalogVersionService(providerId)
      if (currentVersion.version === version) {
        // Cache hit - devolver 304 Not Modified
        res.status(304).end()
        return
      }
    }

    const snapshot = await getCatalogSnapshotService(providerId, {
      limit: parsedLimit,
      cursor: cursor as string | undefined
    })

    res.json(snapshot)
  } catch (e: any) {
    if (e.message === 'PROVIDER_NOT_FOUND') {
      res.status(404).json({
        error: 'PROVIDER_NOT_FOUND',
        message: 'Proveedor no encontrado'
      })
      return
    }
    handleHttp(res, 'ERROR_GET_CATALOG_SNAPSHOT', e)
  }
}

/**
 * GET /catalog/search?q=...&providerId=...&barcode=...&limit=...
 * Búsqueda de productos para matching
 */
export const searchProducts = async (req: RequestExt, res: Response): Promise<void> => {
  try {
    const { q, providerId, barcode, sku, limit } = req.query

    // Validar providerId si viene
    if (providerId && typeof providerId === 'string' && !isValidObjectId(providerId)) {
      res.status(400).json({
        error: 'INVALID_PROVIDER_ID',
        message: 'El providerId no tiene un formato válido'
      })
      return
    }

    const parsedLimit = limit ? Math.min(Math.max(parseInt(limit as string, 10), 1), 100) : 20

    const results = await searchProductsService({
      q: q as string | undefined,
      providerId: providerId as string | undefined,
      barcode: barcode as string | undefined,
      sku: sku as string | undefined,
      limit: parsedLimit
    })

    res.json({
      results,
      count: results.length,
      query: {
        q: q || null,
        providerId: providerId || null,
        barcode: barcode || null,
        sku: sku || null
      }
    })
  } catch (e: any) {
    if (e.message === 'SEARCH_CRITERIA_REQUIRED') {
      res.status(400).json({
        error: 'SEARCH_CRITERIA_REQUIRED',
        message: 'Debe proporcionar al menos q, barcode o sku'
      })
      return
    }
    handleHttp(res, 'ERROR_SEARCH_PRODUCTS', e)
  }
}

/**
 * GET /catalog/providers
 * Obtiene todos los proveedores con su versión de catálogo
 */
export const getAllProvidersWithVersion = async (_req: RequestExt, res: Response): Promise<void> => {
  try {
    const providers = await getAllProvidersWithVersionService()
    
    res.json({
      providers,
      count: providers.length
    })
  } catch (e: any) {
    handleHttp(res, 'ERROR_GET_PROVIDERS', e)
  }
}
