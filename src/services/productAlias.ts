import { Types } from 'mongoose'
import ProductAliasModel from '../models/productAlias'
import CatalogVersionModel from '../models/catalogVersion'
import ConfirmedItemMatchModel from '../models/confirmedItemMatch'
import { insertLog } from './log'
import { normalizeText, normalizeBarcode, generateVersion } from '../utils/normalize'
import {
  IProductAlias,
  AliasType,
  UpsertAliasDTO,
  CreateConfirmedMatchDTO,
  CatalogVersionReason,
  IConfirmedItemMatch
} from '../interfaces/catalog.interface'

/**
 * Upsert de alias de producto
 * Si existe, incrementa usedCount y actualiza lastUsed
 * Si no existe, crea nuevo
 */
export const upsertProductAlias = async (dto: UpsertAliasDTO): Promise<IProductAlias> => {
  const normalizedValue = dto.aliasType === AliasType.BARCODE
    ? normalizeBarcode(dto.aliasValueRaw)
    : normalizeText(dto.aliasValueRaw)

  if (!normalizedValue) {
    throw new Error('El valor del alias no puede estar vacío después de normalizar')
  }

  const filter = {
    providerId: new Types.ObjectId(dto.providerId),
    aliasType: dto.aliasType,
    aliasValueNormalized: normalizedValue
  }

  const now = new Date()
  const userId = new Types.ObjectId(dto.userId)

  const update = {
    $set: {
      aliasValueRaw: dto.aliasValueRaw,
      productId: new Types.ObjectId(dto.productId),
      confidence: dto.confidence ?? 0.95,
      isActive: true,
      'stats.lastUsedAt': now,
      'stats.lastUsedBy': userId
    },
    $inc: {
      'stats.usedCount': 1
    },
    $setOnInsert: {
      providerId: filter.providerId,
      aliasType: dto.aliasType,
      aliasValueNormalized: normalizedValue,
      createdBy: userId,
      createdAt: now
    }
  }

  const alias = await ProductAliasModel.findOneAndUpdate(filter, update, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true
  })

  // Actualizar versión del catálogo
  await bumpCatalogVersion(dto.providerId, CatalogVersionReason.ALIAS_UPSERT, dto.userId)

  // Log de auditoría
  await insertLog({
    accion: 'upsert',
    coleccion: 'productAlias',
    idColeccion: alias._id,
    userId,
    metadata: {
      providerId: dto.providerId,
      productId: dto.productId,
      aliasType: dto.aliasType,
      aliasValueNormalized: normalizedValue
    }
  })

  return alias
}

/**
 * Upsert múltiple de aliases (para confirmación de compra con varios ítems)
 */
export const upsertMultipleAliases = async (
  aliases: UpsertAliasDTO[]
): Promise<IProductAlias[]> => {
  const results: IProductAlias[] = []

  for (const dto of aliases) {
    try {
      const alias = await upsertProductAlias(dto)
      results.push(alias)
    } catch (error) {
      console.error(`Error upserting alias: ${dto.aliasValueRaw}`, error)
      // Continuar con los demás aliases
    }
  }

  return results
}

/**
 * Obtener aliases de un proveedor
 */
export const getAliasesByProvider = async (
  providerId: string,
  options?: { limit?: number, activeOnly?: boolean }
): Promise<any[]> => {
  const query: any = {
    providerId: new Types.ObjectId(providerId)
  }

  if (options?.activeOnly !== false) {
    query.isActive = true
  }

  return await ProductAliasModel.find(query)
    .select('aliasType aliasValueNormalized productId confidence')
    .limit(options?.limit ?? 10000)
    .lean()
}

/**
 * Buscar alias exacto
 */
export const findExactAlias = async (
  providerId: string,
  aliasType: AliasType,
  value: string
): Promise<any | null> => {
  const normalizedValue = aliasType === AliasType.BARCODE
    ? normalizeBarcode(value)
    : normalizeText(value)

  return await ProductAliasModel.findOne({
    providerId: new Types.ObjectId(providerId),
    aliasType,
    aliasValueNormalized: normalizedValue,
    isActive: true
  }).lean()
}

/**
 * Buscar alias por valor (sin restricción de proveedor)
 */
export const findAliasByValue = async (
  aliasType: AliasType,
  value: string
): Promise<any[]> => {
  const normalizedValue = aliasType === AliasType.BARCODE
    ? normalizeBarcode(value)
    : normalizeText(value)

  return await ProductAliasModel.find({
    aliasType,
    aliasValueNormalized: normalizedValue,
    isActive: true
  }).lean()
}

/**
 * Desactivar alias (soft delete)
 */
export const deactivateAlias = async (
  aliasId: string,
  userId: string
): Promise<IProductAlias | null> => {
  const alias = await ProductAliasModel.findByIdAndUpdate(
    aliasId,
    {
      $set: { isActive: false }
    },
    { new: true }
  )

  if (alias != null) {
    // Actualizar versión del catálogo
    await bumpCatalogVersion(
      alias.providerId.toString(),
      CatalogVersionReason.ALIAS_DELETED,
      userId
    )

    // Log de auditoría
    await insertLog({
      accion: 'delete',
      coleccion: 'productAlias',
      idColeccion: alias._id,
      userId: new Types.ObjectId(userId),
      metadata: {
        providerId: alias.providerId.toString(),
        productId: alias.productId.toString(),
        aliasType: alias.aliasType
      }
    })
  }

  return alias
}

/**
 * Registrar confirmación de match (historial)
 */
export const createConfirmedMatch = async (dto: CreateConfirmedMatchDTO): Promise<IConfirmedItemMatch> => {
  const match = await ConfirmedItemMatchModel.create({
    providerId: new Types.ObjectId(dto.providerId),
    rawDescription: dto.rawDescription,
    normalizedDescription: normalizeText(dto.rawDescription),
    detected: dto.detected ?? {},
    chosen: {
      productId: new Types.ObjectId(dto.chosen.productId),
      method: dto.chosen.method,
      suggestionScore: dto.chosen.suggestionScore,
      suggestionRank: dto.chosen.suggestionRank
    },
    doc: (dto.doc != null)
      ? {
          draftId: dto.doc.draftId ? new Types.ObjectId(dto.doc.draftId) : undefined,
          buyId: dto.doc.buyId ? new Types.ObjectId(dto.doc.buyId) : undefined,
          date: dto.doc.date,
          total: dto.doc.total
        }
      : {},
    createdBy: new Types.ObjectId(dto.userId)
  })

  // Log de auditoría
  await insertLog({
    accion: 'create',
    coleccion: 'confirmedItemMatch',
    idColeccion: match._id,
    userId: new Types.ObjectId(dto.userId),
    metadata: {
      providerId: dto.providerId,
      productId: dto.chosen.productId,
      method: dto.chosen.method
    }
  })

  return match
}

/**
 * Registrar múltiples confirmaciones (para compra completa)
 */
export const createMultipleConfirmedMatches = async (
  matches: CreateConfirmedMatchDTO[]
): Promise<IConfirmedItemMatch[]> => {
  const results: IConfirmedItemMatch[] = []

  for (const dto of matches) {
    try {
      const match = await createConfirmedMatch(dto)
      results.push(match)
    } catch (error) {
      console.error(`Error creating confirmed match: ${dto.rawDescription}`, error)
    }
  }

  return results
}

/**
 * Obtener historial de confirmaciones por proveedor
 */
export const getConfirmedMatchesByProvider = async (
  providerId: string,
  options?: { limit?: number, skip?: number }
): Promise<any[]> => {
  return await ConfirmedItemMatchModel.find({
    providerId: new Types.ObjectId(providerId)
  })
    .sort({ createdAt: -1 })
    .skip(options?.skip ?? 0)
    .limit(options?.limit ?? 100)
    .lean()
}

/**
 * Bump versión del catálogo para un proveedor
 */
export const bumpCatalogVersion = async (
  providerId: string,
  reason: CatalogVersionReason,
  userId?: string
): Promise<string> => {
  const newVersion = generateVersion()

  await CatalogVersionModel.findOneAndUpdate(
    { providerId: new Types.ObjectId(providerId) },
    {
      $set: {
        version: newVersion,
        reason,
        triggeredBy: userId ? new Types.ObjectId(userId) : null,
        updatedAt: new Date()
      },
      $setOnInsert: {
        providerId: new Types.ObjectId(providerId)
      }
    },
    { upsert: true, new: true }
  )

  return newVersion
}

/**
 * Obtener versión actual del catálogo de un proveedor
 */
export const getCatalogVersionByProvider = async (providerId: string): Promise<{
  version: string
  updatedAt: Date
} | null> => {
  const catalogVersion = await CatalogVersionModel.findOne({
    providerId: new Types.ObjectId(providerId)
  }).lean()

  if (catalogVersion != null) {
    return {
      version: catalogVersion.version,
      updatedAt: catalogVersion.updatedAt
    }
  }

  return null
}
