import { Request, Response } from 'express'
import { JwtPayload } from 'jsonwebtoken'
import { handleHttp } from '../utils/error.handle'
import { isValidObjectId } from '../utils/normalize'
import { AliasType } from '../interfaces/catalog.interface'
import { listAliasesByProvider } from '../services/productAlias'

interface RequestExt extends Request {
  user?: string | JwtPayload | any
}

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

/**
 * GET /catalog/aliases?providerId=&aliasType=&limit=&cursor=
 * Listado paginado de aliases aprendidos para un proveedor.
 * Requiere el permiso catalog_read en la capa de rutas.
 */
export const listAliases = async ({ query }: RequestExt, res: Response): Promise<void> => {
  try {
    const { providerId, aliasType, limit, cursor } = query as Record<string, any>

    if (providerId === undefined || providerId === null || providerId === '') {
      res.status(400).json({
        error: 'PROVIDER_ID_REQUIRED',
        message: 'El parámetro providerId es obligatorio'
      })
      return
    }

    if (typeof providerId !== 'string' || !isValidObjectId(providerId)) {
      res.status(400).json({
        error: 'INVALID_PROVIDER_ID',
        message: 'El providerId no tiene un formato válido'
      })
      return
    }

    if (aliasType !== undefined && !(Object.values(AliasType) as string[]).includes(String(aliasType))) {
      res.status(400).json({
        error: 'INVALID_ALIAS_TYPE',
        message: `aliasType debe ser uno de: ${Object.values(AliasType).join(', ')}`
      })
      return
    }

    if (cursor !== undefined && (typeof cursor !== 'string' || !isValidObjectId(cursor))) {
      res.status(400).json({
        error: 'INVALID_CURSOR',
        message: 'El cursor no tiene un formato válido'
      })
      return
    }

    let parsedLimit = DEFAULT_LIMIT
    if (limit !== undefined) {
      parsedLimit = Number(limit)
      if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
        res.status(400).json({
          error: 'INVALID_LIMIT',
          message: 'limit debe ser un número mayor a 0'
        })
        return
      }
    }

    const page = await listAliasesByProvider(providerId, {
      aliasType: aliasType === undefined ? undefined : (aliasType as AliasType),
      limit: Math.min(Math.floor(parsedLimit), MAX_LIMIT),
      cursor: cursor === undefined ? undefined : String(cursor)
    })

    res.json(page)
  } catch (error: any) {
    handleHttp(res, 'ERROR_LIST_CATALOG_ALIASES', error)
  }
}
