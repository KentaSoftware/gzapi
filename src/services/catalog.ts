import { Types } from 'mongoose'
import ProductModel from '../models/product'
import ProductAliasModel from '../models/productAlias'
import CatalogVersionModel from '../models/catalogVersion'
import ProviderModel from '../models/provider'
import { normalizeText, normalizeBarcode } from '../utils/normalize'
import {
  CatalogSnapshotResponse,
  CatalogVersionResponse,
  ProductSearchResult,
  ProductSearchQuery,
  SnapshotProduct,
  SnapshotAlias
} from '../interfaces/catalog.interface'

/**
 * Obtener versión del catálogo de un proveedor
 */
export const getCatalogVersionService = async (providerId: string): Promise<CatalogVersionResponse> => {
  // Validar que el proveedor existe
  const provider = await ProviderModel.findById(providerId).lean()
  if (!provider) {
    throw new Error('PROVIDER_NOT_FOUND')
  }

  // Buscar versión almacenada
  const storedVersion = await CatalogVersionModel.findOne({
    providerId: new Types.ObjectId(providerId)
  }).lean()

  if (storedVersion) {
    return {
      providerId,
      version: storedVersion.version,
      updatedAt: storedVersion.updatedAt
    }
  }

  // Si no existe, calcular on-demand
  const [latestProduct, latestAlias] = await Promise.all([
    ProductModel.findOne({ proveedor: new Types.ObjectId(providerId) })
      .sort({ updatedAt: -1 })
      .select('updatedAt')
      .lean(),
    ProductAliasModel.findOne({ providerId: new Types.ObjectId(providerId) })
      .sort({ updatedAt: -1 })
      .select('updatedAt')
      .lean()
  ])

  const dates = [
    latestProduct?.updatedAt,
    latestAlias?.updatedAt
  ].filter(Boolean) as Date[]

  const latestDate = dates.length > 0
    ? dates.sort((a, b) => b.getTime() - a.getTime())[0]
    : new Date()

  const version = `DYNAMIC-${latestDate.getTime()}`

  return {
    providerId,
    version,
    updatedAt: latestDate
  }
}

/**
 * Obtener snapshot liviano del catálogo
 */
export const getCatalogSnapshotService = async (
  providerId: string,
  options: {
    limit?: number
    cursor?: string
    version?: string
  } = {}
): Promise<CatalogSnapshotResponse> => {
  const { limit = 500, cursor } = options

  // Validar que el proveedor existe
  const provider = await ProviderModel.findById(providerId).lean()
  if (!provider) {
    throw new Error('PROVIDER_NOT_FOUND')
  }

  // Obtener versión actual
  const versionInfo = await getCatalogVersionService(providerId)

  // Query base para productos del proveedor
  const productQuery: any = {
    proveedor: new Types.ObjectId(providerId)
  }

  // Si hay cursor, usarlo para paginación (cursor = último _id)
  if (cursor) {
    productQuery._id = { $gt: new Types.ObjectId(cursor) }
  }

  // Obtener productos con proyección liviana
  const products = await ProductModel.find(productQuery)
    .select('_id descripcion codigoBarra categoria marca proveedor updatedAt')
    .sort({ _id: 1 })
    .limit(limit + 1) // +1 para saber si hay más
    .lean()

  const hasMore = products.length > limit
  if (hasMore) {
    products.pop() // Remover el extra
  }

  // Transformar productos al formato snapshot
  const snapshotProducts: SnapshotProduct[] = products.map((p: any) => ({
    productId: p._id.toString(),
    name: p.descripcion,
    normalizedName: normalizeText(p.descripcion),
    providerId: p.proveedor.toString(),
    brandId: p.marca.toString(),
    categoryId: p.categoria.toString(),
    active: true, // No existe isActive en schema actual
    barcodes: p.codigoBarra ? [p.codigoBarra] : [],
    skus: [], // No existe SKU en schema actual
    updatedAt: p.updatedAt
  }))

  // Obtener aliases del proveedor (solo si es primera página)
  let snapshotAliases: SnapshotAlias[] = []
  if (!cursor) {
    const aliases = await ProductAliasModel.find({
      providerId: new Types.ObjectId(providerId),
      isActive: true
    })
      .select('aliasType aliasValueNormalized productId confidence')
      .lean()

    snapshotAliases = aliases.map(a => ({
      aliasType: a.aliasType,
      aliasValueNormalized: a.aliasValueNormalized,
      productId: a.productId.toString(),
      confidence: a.confidence
    }))
  }

  // Contar total de productos (solo si es primera página)
  let totalProducts = 0
  if (!cursor) {
    totalProducts = await ProductModel.countDocuments({
      proveedor: new Types.ObjectId(providerId)
    })
  }

  const lastProduct = products[products.length - 1]
  const nextCursor = hasMore && lastProduct ? lastProduct._id.toString() : null

  return {
    providerId,
    version: versionInfo.version,
    generatedAt: new Date(),
    products: snapshotProducts,
    aliases: snapshotAliases,
    pagination: {
      nextCursor,
      hasMore,
      totalProducts
    }
  }
}

/**
 * Búsqueda de productos para matching
 */
export const searchProductsService = async (
  query: ProductSearchQuery
): Promise<ProductSearchResult[]> => {
  const { q, providerId, barcode, sku, limit = 20 } = query

  // Validar que hay al menos un criterio de búsqueda
  if (!q && !barcode && !sku) {
    throw new Error('SEARCH_CRITERIA_REQUIRED')
  }

  const results: ProductSearchResult[] = []

  // 1. Búsqueda por código de barras (exacta)
  if (barcode) {
    const normalizedBarcode = normalizeBarcode(barcode)
    
    const matchQuery: any = { codigoBarra: normalizedBarcode }
    if (providerId) {
      matchQuery.proveedor = new Types.ObjectId(providerId)
    }

    const barcodeMatches = await ProductModel.aggregate([
      { $match: matchQuery },
      {
        $lookup: {
          from: 'providers',
          localField: 'proveedor',
          foreignField: '_id',
          as: 'providerData'
        }
      },
      {
        $lookup: {
          from: 'brands',
          localField: 'marca',
          foreignField: '_id',
          as: 'brandData'
        }
      },
      {
        $lookup: {
          from: 'categories',
          localField: 'categoria',
          foreignField: '_id',
          as: 'categoryData'
        }
      },
      { $unwind: { path: '$providerData', preserveNullAndEmptyArrays: true } },
      { $unwind: { path: '$brandData', preserveNullAndEmptyArrays: true } },
      { $unwind: { path: '$categoryData', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          productId: '$_id',
          name: '$descripcion',
          barcode: '$codigoBarra',
          providerId: '$proveedor',
          providerName: '$providerData.descripcion',
          brandId: '$marca',
          brandName: '$brandData.descripcion',
          categoryId: '$categoria',
          categoryName: '$categoryData.descripcion'
        }
      },
      { $limit: limit }
    ])

    for (const match of barcodeMatches) {
      results.push({
        productId: match.productId.toString(),
        name: match.name,
        normalizedName: normalizeText(match.name),
        barcode: match.barcode || null,
        providerId: match.providerId.toString(),
        providerName: match.providerName || '',
        brandId: match.brandId.toString(),
        brandName: match.brandName || '',
        categoryId: match.categoryId.toString(),
        categoryName: match.categoryName || '',
        matchScore: 1.0,
        matchSource: 'BARCODE'
      })
    }

    // Si encontramos por barcode exacto, retornar inmediatamente
    if (results.length > 0) {
      return results
    }
  }

  // 2. Búsqueda por texto (descripción)
  if (q) {
    const normalizedQuery = normalizeText(q)
    
    // Primero buscar en aliases
    const aliasQuery: any = {
      aliasValueNormalized: normalizedQuery,
      isActive: true
    }
    if (providerId) {
      aliasQuery.providerId = new Types.ObjectId(providerId)
    }

    const aliasMatch = await ProductAliasModel.findOne(aliasQuery).lean()
    
    if (aliasMatch) {
      // Encontramos alias exacto, buscar el producto
      const product = await ProductModel.aggregate([
        { $match: { _id: aliasMatch.productId } },
        {
          $lookup: {
            from: 'providers',
            localField: 'proveedor',
            foreignField: '_id',
            as: 'providerData'
          }
        },
        {
          $lookup: {
            from: 'brands',
            localField: 'marca',
            foreignField: '_id',
            as: 'brandData'
          }
        },
        {
          $lookup: {
            from: 'categories',
            localField: 'categoria',
            foreignField: '_id',
            as: 'categoryData'
          }
        },
        { $unwind: { path: '$providerData', preserveNullAndEmptyArrays: true } },
        { $unwind: { path: '$brandData', preserveNullAndEmptyArrays: true } },
        { $unwind: { path: '$categoryData', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            productId: '$_id',
            name: '$descripcion',
            barcode: '$codigoBarra',
            providerId: '$proveedor',
            providerName: '$providerData.descripcion',
            brandId: '$marca',
            brandName: '$brandData.descripcion',
            categoryId: '$categoria',
            categoryName: '$categoryData.descripcion'
          }
        }
      ])

      if (product[0]) {
        results.push({
          productId: product[0].productId.toString(),
          name: product[0].name,
          normalizedName: normalizeText(product[0].name),
          barcode: product[0].barcode || null,
          providerId: product[0].providerId.toString(),
          providerName: product[0].providerName || '',
          brandId: product[0].brandId.toString(),
          brandName: product[0].brandName || '',
          categoryId: product[0].categoryId.toString(),
          categoryName: product[0].categoryName || '',
          matchScore: aliasMatch.confidence,
          matchSource: 'ALIAS'
        })
      }
    }

    // Búsqueda regex en descripción
    // Escapar caracteres especiales de regex
    const escapedQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    
    const descQuery: any = {
      descripcion: { $regex: escapedQ, $options: 'i' }
    }
    if (providerId) {
      descQuery.proveedor = new Types.ObjectId(providerId)
    }

    const descMatches = await ProductModel.aggregate([
      { $match: descQuery },
      {
        $lookup: {
          from: 'providers',
          localField: 'proveedor',
          foreignField: '_id',
          as: 'providerData'
        }
      },
      {
        $lookup: {
          from: 'brands',
          localField: 'marca',
          foreignField: '_id',
          as: 'brandData'
        }
      },
      {
        $lookup: {
          from: 'categories',
          localField: 'categoria',
          foreignField: '_id',
          as: 'categoryData'
        }
      },
      { $unwind: { path: '$providerData', preserveNullAndEmptyArrays: true } },
      { $unwind: { path: '$brandData', preserveNullAndEmptyArrays: true } },
      { $unwind: { path: '$categoryData', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          productId: '$_id',
          name: '$descripcion',
          barcode: '$codigoBarra',
          providerId: '$proveedor',
          providerName: '$providerData.descripcion',
          brandId: '$marca',
          brandName: '$brandData.descripcion',
          categoryId: '$categoria',
          categoryName: '$categoryData.descripcion'
        }
      },
      { $limit: limit }
    ])

    for (const match of descMatches) {
      // Evitar duplicados si ya lo encontramos por alias
      const exists = results.some(r => r.productId === match.productId.toString())
      if (!exists) {
        results.push({
          productId: match.productId.toString(),
          name: match.name,
          normalizedName: normalizeText(match.name),
          barcode: match.barcode || null,
          providerId: match.providerId.toString(),
          providerName: match.providerName || '',
          brandId: match.brandId.toString(),
          brandName: match.brandName || '',
          categoryId: match.categoryId.toString(),
          categoryName: match.categoryName || '',
          matchScore: 0.5, // Score menor para regex
          matchSource: 'DESCRIPTION'
        })
      }
    }
  }

  // Ordenar por score descendente
  results.sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0))

  return results.slice(0, limit)
}

/**
 * Obtener todos los proveedores con su versión de catálogo
 */
export const getAllProvidersWithVersionService = async (): Promise<Array<{
  providerId: string
  providerName: string
  version: string | null
  updatedAt: Date | null
  productCount: number
}>> => {
  const providers = await ProviderModel.find({}).lean()
  
  const results = await Promise.all(
    providers.map(async (provider) => {
      const [versionInfo, productCount] = await Promise.all([
        CatalogVersionModel.findOne({ providerId: provider._id }).lean(),
        ProductModel.countDocuments({ proveedor: provider._id })
      ])

      return {
        providerId: provider._id.toString(),
        providerName: provider.descripcion,
        version: versionInfo?.version ?? null,
        updatedAt: versionInfo?.updatedAt ?? null,
        productCount
      }
    })
  )

  return results
}
