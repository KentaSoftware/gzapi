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
import {
  upsertProductAlias,
  createConfirmedMatch
} from '../services/productAlias'
import { AliasType, MatchMethod } from '../interfaces/catalog.interface'

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

/**
 * POST /catalog/aliases
 * Crea o actualiza un alias de producto
 * @access Private (catalog_write)
 */
export const createOrUpdateAlias = async (req: RequestExt, res: Response): Promise<void> => {
  try {
    const { providerId, aliasType, aliasValueRaw, productId, confidence } = req.body
    const userId = req.user?.id

    // Validaciones
    if (!providerId || !aliasType || !aliasValueRaw || !productId) {
      res.status(400).json({
        error: 'MISSING_REQUIRED_FIELDS',
        message: 'Los campos providerId, aliasType, aliasValueRaw y productId son obligatorios'
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

    if (!isValidObjectId(productId)) {
      res.status(400).json({
        error: 'INVALID_PRODUCT_ID',
        message: 'El productId no tiene un formato válido'
      })
      return
    }

    // Validar aliasType
    const validAliasTypes = Object.values(AliasType)
    if (!validAliasTypes.includes(aliasType)) {
      res.status(400).json({
        error: 'INVALID_ALIAS_TYPE',
        message: `El aliasType debe ser uno de: ${validAliasTypes.join(', ')}`
      })
      return
    }

    // Validar confidence si viene
    if (confidence !== undefined && (typeof confidence !== 'number' || confidence < 0 || confidence > 1)) {
      res.status(400).json({
        error: 'INVALID_CONFIDENCE',
        message: 'El confidence debe ser un número entre 0 y 1'
      })
      return
    }

    // Upsert alias
    const alias = await upsertProductAlias({
      providerId,
      aliasType,
      aliasValueRaw,
      productId,
      confidence,
      userId
    })

    res.status(201).json({
      success: true,
      alias: {
        id: alias._id,
        providerId: alias.providerId,
        aliasType: alias.aliasType,
        aliasValueRaw: alias.aliasValueRaw,
        aliasValueNormalized: alias.aliasValueNormalized,
        productId: alias.productId,
        confidence: alias.confidence,
        usedCount: alias.stats?.usedCount || 0,
        isActive: alias.isActive
      }
    })
  } catch (e: any) {
    if (e.message?.includes('vacío después de normalizar')) {
      res.status(400).json({
        error: 'INVALID_ALIAS_VALUE',
        message: e.message
      })
      return
    }
    handleHttp(res, 'ERROR_CREATE_ALIAS', e)
  }
}

/**
 * POST /catalog/matches/confirm
 * Confirma un matching y aprende del resultado
 * @access Private (catalog_write)
 */
export const confirmMatch = async (req: RequestExt, res: Response): Promise<void> => {
  try {
    const {
      providerId,
      rawDescription,
      normalizedDescription,
      productId,
      method,
      suggestionScore,
      suggestionRank,
      detected,
      doc
    } = req.body
    const userId = req.user?.id

    // Validaciones
    if (!providerId || !rawDescription || !productId || !method) {
      res.status(400).json({
        error: 'MISSING_REQUIRED_FIELDS',
        message: 'Los campos providerId, rawDescription, productId y method son obligatorios'
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

    if (!isValidObjectId(productId)) {
      res.status(400).json({
        error: 'INVALID_PRODUCT_ID',
        message: 'El productId no tiene un formato válido'
      })
      return
    }

    // Validar method
    const validMethods = Object.values(MatchMethod)
    if (!validMethods.includes(method)) {
      res.status(400).json({
        error: 'INVALID_METHOD',
        message: `El method debe ser uno de: ${validMethods.join(', ')}`
      })
      return
    }

    // Crear registro de confirmación
    const confirmedMatch = await createConfirmedMatch({
      providerId,
      rawDescription,
      normalizedDescription,
      detected,
      chosen: {
        productId,
        method,
        suggestionScore,
        suggestionRank
      },
      doc,
      userId
    })

    // Si el método fue MANUAL_SELECTION o FUZZY_MATCH, crear alias automáticamente
    // para aprender de la elección del usuario
    if (method === MatchMethod.MANUAL_SELECTION || method === MatchMethod.FUZZY_MATCH) {
      try {
        await upsertProductAlias({
          providerId,
          aliasType: AliasType.DESCRIPTION,
          aliasValueRaw: rawDescription,
          productId,
          confidence: method === MatchMethod.MANUAL_SELECTION ? 1.0 : (suggestionScore || 0.8),
          userId
        })
      } catch (aliasError) {
        // Log pero no fallar el request
        console.error('Error creando alias automático:', aliasError)
      }
    }

    res.status(201).json({
      success: true,
      confirmedMatch: {
        id: confirmedMatch._id,
        providerId: confirmedMatch.providerId,
        rawDescription: confirmedMatch.rawDescription,
        productId: confirmedMatch.chosen.productId,
        method: confirmedMatch.chosen.method,
        createdAt: confirmedMatch.createdAt
      }
    })
  } catch (e: any) {
    handleHttp(res, 'ERROR_CONFIRM_MATCH', e)
  }
}

/**
 * POST /catalog/search/batch
 * Búsqueda batch de productos con soporte para PROVIDER_FIRST, PROVIDER_ONLY, GLOBAL_ONLY
 */
export const batchSearch = async (req: RequestExt, res: Response): Promise<void> => {
  try {
    const { queries, providerId, scope, topK, minCandidates } = req.body

    // Validar queries array
    if (!queries || !Array.isArray(queries)) {
      res.status(400).json({
        error: 'INVALID_QUERIES',
        message: 'El campo queries debe ser un array'
      })
      return
    }

    if (queries.length === 0) {
      res.status(400).json({
        error: 'EMPTY_QUERIES',
        message: 'El array queries no puede estar vacío'
      })
      return
    }

    if (queries.length > 50) {
      res.status(400).json({
        error: 'TOO_MANY_QUERIES',
        message: 'El máximo de queries por batch es 50'
      })
      return
    }

    // Validar cada query
    for (let i = 0; i < queries.length; i++) {
      const query = queries[i]

      if (!query.queryId) {
        res.status(400).json({
          error: 'MISSING_QUERY_ID',
          message: `La query en posición ${i} no tiene queryId`
        })
        return
      }

      if (!query.q && !query.barcode) {
        res.status(400).json({
          error: 'MISSING_SEARCH_TERM',
          message: `La query ${query.queryId} debe tener al menos 'q' o 'barcode'`
        })
        return
      }

      if (query.q && query.q.length < 2) {
        res.status(400).json({
          error: 'QUERY_TOO_SHORT',
          message: `La query ${query.queryId} tiene un término de búsqueda demasiado corto (mínimo 2 caracteres)`
        })
        return
      }
    }

    // Validar providerId si está presente
    if (providerId && !isValidObjectId(providerId)) {
      res.status(400).json({
        error: 'INVALID_PROVIDER_ID',
        message: 'El providerId no tiene un formato válido'
      })
      return
    }

    // Validar scope si está presente
    const validScopes = ['PROVIDER_ONLY', 'GLOBAL_ONLY', 'PROVIDER_FIRST']
    if (scope && !validScopes.includes(scope)) {
      res.status(400).json({
        error: 'INVALID_SCOPE',
        message: `El scope debe ser uno de: ${validScopes.join(', ')}`
      })
      return
    }

    // Validar topK si está presente
    if (topK !== undefined) {
      if (!Number.isInteger(topK) || topK < 1 || topK > 50) {
        res.status(400).json({
          error: 'INVALID_TOP_K',
          message: 'El parámetro topK debe ser un entero entre 1 y 50'
        })
        return
      }
    }

    // Validar minCandidates si está presente
    if (minCandidates !== undefined) {
      if (!Number.isInteger(minCandidates) || minCandidates < 0) {
        res.status(400).json({
          error: 'INVALID_MIN_CANDIDATES',
          message: 'El parámetro minCandidates debe ser un entero >= 0'
        })
        return
      }
    }

    // Importar servicio y ejecutar búsqueda
    const { batchCatalogSearchService } = await import('../services/catalog')
    const result = await batchCatalogSearchService(req.body)

    res.json(result)
  } catch (e: any) {
    handleHttp(res, 'ERROR_BATCH_SEARCH', e)
  }
}
