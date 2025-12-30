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

// ============================================
// BATCH CATALOG SEARCH
// ============================================

import {
  BatchCatalogSearchRequest,
  BatchCatalogSearchResponse,
  CatalogQuery,
  CatalogSearchResult,
  CatalogSearchScope,
  ProductSummary,
  RetrievalMethod
} from '../interfaces/catalog.interface'

/**
 * Mapea Product de MongoDB a ProductSummary (payload liviano)
 */
function mapToProductSummary(product: any): ProductSummary {
  return {
    productId: product._id.toString(),
    description: product.descripcion || product.description || '',
    codigoBarra: product.codigoBarra || undefined,
    proveedor: product.proveedor?.toString() || undefined,
    categoria: product.categoria?.toString() || undefined,
    marca: product.marca?.toString() || undefined,
    unidad: product.unidad || undefined,
    pack: product.pack || 1
  }
}

/**
 * Búsqueda de candidatos por barcode exacto
 */
async function searchByBarcode(
  barcode: string,
  providerId?: string,
  limit: number = 20
): Promise<ProductSummary[]> {
  const normalizedBarcode = normalizeBarcode(barcode)
  
  const filter: any = {
    codigoBarra: normalizedBarcode
  }
  
  if (providerId) {
    filter.proveedor = new Types.ObjectId(providerId)
  }
  
  const products = await ProductModel.find(filter)
    .select('_id descripcion description codigoBarra proveedor categoria marca unidad pack')
    .limit(limit)
    .lean()
  
  return products.map(mapToProductSummary)
}

/**
 * Búsqueda de candidatos por texto
 * Estrategia: Regex con tokens normalizados
 */
async function searchByText(
  q: string,
  providerId?: string,
  limit: number = 20
): Promise<ProductSummary[]> {
  const normalized = normalizeText(q)
  
  // Tokenizar query (split por espacios)
  const tokens = normalized.split(/\s+/).filter(t => t.length >= 2)
  
  if (tokens.length === 0) {
    return []
  }
  
  // Crear regex: buscar todos los tokens (orden independiente)
  const regexPattern = tokens.map(t => `(?=.*${t})`).join('')
  const regex = new RegExp(regexPattern, 'i')
  
  const filter: any = {
    $or: [
      { descripcion: regex },
      { description: regex }
    ]
  }
  
  if (providerId) {
    filter.proveedor = new Types.ObjectId(providerId)
  }
  
  const products = await ProductModel.find(filter)
    .select('_id descripcion description codigoBarra proveedor categoria marca unidad pack')
    .limit(limit)
    .lean()
  
  return products.map(mapToProductSummary)
}

/**
 * Procesa una query individual con scope PROVIDER_FIRST
 */
async function processQueryProviderFirst(
  query: CatalogQuery,
  providerId: string,
  topK: number,
  minCandidates: number
): Promise<CatalogSearchResult> {
  const methods: RetrievalMethod[] = []
  
  let providerCandidates: ProductSummary[] = []
  let globalCandidates: ProductSummary[] = []
  
  // 1. Búsqueda por provider
  if (query.barcode) {
    providerCandidates = await searchByBarcode(query.barcode, providerId, topK)
    methods.push(RetrievalMethod.BARCODE_EXACT)
  } else if (query.q && query.q.length >= 2) {
    providerCandidates = await searchByText(query.q, providerId, topK)
    methods.push(RetrievalMethod.TEXT_REGEX)
  }
  
  const providerCount = providerCandidates.length
  
  // 2. Si no hay suficientes, buscar global
  if (providerCount < minCandidates) {
    if (query.barcode) {
      globalCandidates = await searchByBarcode(query.barcode, undefined, topK)
    } else if (query.q && query.q.length >= 2) {
      globalCandidates = await searchByText(query.q, undefined, topK)
    }
    methods.push(RetrievalMethod.GLOBAL_FALLBACK)
  }
  
  // 3. Merge y dedup (priorizar provider)
  const allCandidates = [...providerCandidates, ...globalCandidates]
  const seen = new Set<string>()
  const unique: ProductSummary[] = []
  
  for (const candidate of allCandidates) {
    if (!seen.has(candidate.productId)) {
      seen.add(candidate.productId)
      unique.push(candidate)
    }
  }
  
  // 4. Limitar a topK
  const finalCandidates = unique.slice(0, topK)
  
  return {
    queryId: query.queryId,
    query: {
      q: query.q || null,
      barcode: query.barcode || null
    },
    candidates: finalCandidates,
    meta: {
      providerCount,
      globalCount: globalCandidates.length,
      totalReturned: finalCandidates.length,
      usedScope: providerCount >= minCandidates 
        ? CatalogSearchScope.PROVIDER_ONLY 
        : CatalogSearchScope.PROVIDER_FIRST,
      retrievalMethods: methods,
      noCandidates: finalCandidates.length === 0
    }
  }
}

/**
 * Procesa una query individual con scope PROVIDER_ONLY
 */
async function processQueryProviderOnly(
  query: CatalogQuery,
  providerId: string,
  topK: number
): Promise<CatalogSearchResult> {
  const methods: RetrievalMethod[] = []
  let candidates: ProductSummary[] = []
  
  if (query.barcode) {
    candidates = await searchByBarcode(query.barcode, providerId, topK)
    methods.push(RetrievalMethod.BARCODE_EXACT)
  } else if (query.q && query.q.length >= 2) {
    candidates = await searchByText(query.q, providerId, topK)
    methods.push(RetrievalMethod.TEXT_REGEX)
  }
  
  return {
    queryId: query.queryId,
    query: {
      q: query.q || null,
      barcode: query.barcode || null
    },
    candidates,
    meta: {
      providerCount: candidates.length,
      globalCount: 0,
      totalReturned: candidates.length,
      usedScope: CatalogSearchScope.PROVIDER_ONLY,
      retrievalMethods: methods,
      noCandidates: candidates.length === 0
    }
  }
}

/**
 * Procesa una query individual con scope GLOBAL_ONLY
 */
async function processQueryGlobalOnly(
  query: CatalogQuery,
  topK: number
): Promise<CatalogSearchResult> {
  const methods: RetrievalMethod[] = []
  let candidates: ProductSummary[] = []
  
  if (query.barcode) {
    candidates = await searchByBarcode(query.barcode, undefined, topK)
    methods.push(RetrievalMethod.BARCODE_EXACT)
  } else if (query.q && query.q.length >= 2) {
    candidates = await searchByText(query.q, undefined, topK)
    methods.push(RetrievalMethod.TEXT_REGEX)
  }
  
  return {
    queryId: query.queryId,
    query: {
      q: query.q || null,
      barcode: query.barcode || null
    },
    candidates,
    meta: {
      providerCount: 0,
      globalCount: candidates.length,
      totalReturned: candidates.length,
      usedScope: CatalogSearchScope.GLOBAL_ONLY,
      retrievalMethods: methods,
      noCandidates: candidates.length === 0
    }
  }
}

/**
 * Servicio principal de batch catalog search
 */
export const batchCatalogSearchService = async (
  request: BatchCatalogSearchRequest
): Promise<BatchCatalogSearchResponse> => {
  const startTime = Date.now()
  
  const {
    queries,
    providerId,
    scope = CatalogSearchScope.PROVIDER_FIRST,
    topK = 20,
    minCandidates = 10
  } = request
  
  // Procesar cada query según el scope
  const results: CatalogSearchResult[] = []
  
  for (const query of queries) {
    let result: CatalogSearchResult
    
    switch (scope) {
      case CatalogSearchScope.PROVIDER_ONLY:
        if (!providerId) {
          throw new Error('providerId is required for PROVIDER_ONLY scope')
        }
        result = await processQueryProviderOnly(query, providerId, topK)
        break
        
      case CatalogSearchScope.GLOBAL_ONLY:
        result = await processQueryGlobalOnly(query, topK)
        break
        
      case CatalogSearchScope.PROVIDER_FIRST:
        if (!providerId) {
          // Si no hay providerId, actuar como GLOBAL_ONLY
          result = await processQueryGlobalOnly(query, topK)
        } else {
          result = await processQueryProviderFirst(query, providerId, topK, minCandidates)
        }
        break
        
      default:
        result = await processQueryGlobalOnly(query, topK)
    }
    
    results.push(result)
  }
  
  const executionTimeMs = Date.now() - startTime
  const avgCandidates = results.reduce((sum, r) => sum + r.candidates.length, 0) / results.length
  
  return {
    success: true,
    results,
    meta: {
      totalQueries: queries.length,
      avgCandidatesPerQuery: Math.round(avgCandidates * 100) / 100,
      executionTimeMs
    }
  }
}
