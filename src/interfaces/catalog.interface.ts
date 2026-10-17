import { Types, Document } from 'mongoose'

// ============================================
// ENUMS
// ============================================
export enum AliasType {
  DESCRIPTION = 'DESCRIPTION',
  BARCODE = 'BARCODE',
  SKU = 'SKU'
}

export enum MatchMethod {
  EXACT_BARCODE = 'EXACT_BARCODE',
  EXACT_ALIAS = 'EXACT_ALIAS',
  FUZZY_MATCH = 'FUZZY_MATCH',
  MANUAL_SELECTION = 'MANUAL_SELECTION'
}

export enum CatalogVersionReason {
  PRODUCT_CREATED = 'PRODUCT_CREATED',
  PRODUCT_UPDATED = 'PRODUCT_UPDATED',
  PRODUCT_DELETED = 'PRODUCT_DELETED',
  ALIAS_UPSERT = 'ALIAS_UPSERT',
  ALIAS_DELETED = 'ALIAS_DELETED',
  MANUAL_BUMP = 'MANUAL_BUMP'
}

// ============================================
// PRODUCT ALIAS
// ============================================
export interface IProductAliasStats {
  usedCount: number
  lastUsedAt: Date | null
  lastUsedBy: Types.ObjectId | null
}

export interface IProductAlias extends Document {
  providerId: Types.ObjectId
  aliasType: AliasType
  aliasValueRaw: string
  aliasValueNormalized: string
  productId: Types.ObjectId
  confidence: number
  stats: IProductAliasStats
  isActive: boolean
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

export interface UpsertAliasDTO {
  providerId: string
  aliasType: AliasType
  aliasValueRaw: string
  productId: string
  confidence?: number
  userId: string
}

// ============================================
// CONFIRMED ITEM MATCH
// ============================================
export interface IConfirmedItemMatchDetected {
  barcode?: string
  unit?: string
  qty?: number
}

export interface IConfirmedItemMatchChosen {
  productId: Types.ObjectId
  method: MatchMethod
  suggestionScore?: number
  suggestionRank?: number
}

export interface IConfirmedItemMatchDoc {
  draftId?: Types.ObjectId
  buyId?: Types.ObjectId
  date?: Date
  total?: number
}

export interface IConfirmedItemMatch extends Document {
  providerId: Types.ObjectId
  rawDescription: string
  normalizedDescription: string
  detected: IConfirmedItemMatchDetected
  chosen: IConfirmedItemMatchChosen
  doc: IConfirmedItemMatchDoc
  createdBy: Types.ObjectId
  createdAt: Date
}

export interface CreateConfirmedMatchDTO {
  providerId: string
  rawDescription: string
  normalizedDescription?: string
  detected?: IConfirmedItemMatchDetected
  chosen: {
    productId: string
    method: MatchMethod
    suggestionScore?: number
    suggestionRank?: number
  }
  doc?: {
    draftId?: string
    buyId?: string
    date?: Date
    total?: number
  }
  userId: string
}

// ============================================
// CATALOG VERSION
// ============================================
export interface ICatalogVersion extends Document {
  providerId: Types.ObjectId
  version: string
  reason: CatalogVersionReason
  triggeredBy: Types.ObjectId
  updatedAt: Date
}

// ============================================
// SNAPSHOT RESPONSE
// ============================================
export interface SnapshotProduct {
  productId: string
  name: string
  normalizedName: string
  providerId: string
  brandId: string
  categoryId: string
  active: boolean
  barcodes: string[]
  skus: string[]
  updatedAt: Date
}

export interface SnapshotAlias {
  aliasType: AliasType
  aliasValueNormalized: string
  productId: string
  confidence: number
}

export interface CatalogSnapshotResponse {
  providerId: string
  version: string
  generatedAt: Date
  products: SnapshotProduct[]
  aliases: SnapshotAlias[]
  pagination: {
    nextCursor: string | null
    hasMore: boolean
    totalProducts: number
  }
}

export interface CatalogVersionResponse {
  providerId: string
  version: string
  updatedAt: Date
}

// ============================================
// SEARCH
// ============================================
export interface ProductSearchQuery {
  q?: string
  providerId?: string
  barcode?: string
  sku?: string
  limit?: number
}

export interface ProductSearchResult {
  productId: string
  name: string
  normalizedName: string
  barcode: string | null
  providerId: string
  providerName: string
  brandId: string
  brandName: string
  categoryId: string
  categoryName: string
  matchScore?: number
  matchSource?: 'BARCODE' | 'DESCRIPTION' | 'ALIAS'
}

// ============================================
// BATCH SEARCH
// ============================================

/**
 * Scope de búsqueda para batch catalog search
 */
export enum CatalogSearchScope {
  PROVIDER_ONLY = 'PROVIDER_ONLY', // Solo buscar en proveedor especificado
  GLOBAL_ONLY = 'GLOBAL_ONLY', // Solo búsqueda global (sin provider)
  PROVIDER_FIRST = 'PROVIDER_FIRST' // Primero provider, fallback a global si necesario
}

/**
 * Métodos de retrieval utilizados
 */
export enum RetrievalMethod {
  BARCODE_EXACT = 'BARCODE_EXACT',
  TEXT_REGEX = 'TEXT_REGEX',
  TEXT_INDEX = 'TEXT_INDEX',
  GLOBAL_FALLBACK = 'GLOBAL_FALLBACK'
}

/**
 * Query individual para batch search
 */
export interface CatalogQuery {
  queryId: string // Identificador único (ej: "L1", "L2")
  q?: string | null // Texto de búsqueda (mínimo 2 caracteres)
  barcode?: string | null // Código de barras (exacto)
}

/**
 * Request para batch catalog search
 */
export interface BatchCatalogSearchRequest {
  queries: CatalogQuery[] // Array de queries (máximo 50)
  providerId?: string // ID del proveedor (opcional)
  scope?: CatalogSearchScope // Default: PROVIDER_FIRST
  topK?: number // Candidatos por query (default: 20, max: 50)
  minCandidates?: number // Mínimo para activar fallback (default: 10)
}

/**
 * Producto resumido (payload liviano)
 */
export interface ProductSummary {
  productId: string // _id del producto
  description: string // Descripción del producto
  codigoBarra?: string // Código de barras (si existe)
  proveedor?: string // ID del proveedor
  categoria?: string // ID de categoría
  marca?: string // ID de marca
  unidad?: string // Unidad de medida (ej: "LITROS", "KG")
  pack?: number // Cantidad en pack (default: 1)
}

/**
 * Metadata de resultado individual
 */
export interface CatalogSearchResultMeta {
  providerCount: number // Candidatos encontrados por provider
  globalCount: number // Candidatos encontrados global
  totalReturned: number // Total devuelto
  usedScope: CatalogSearchScope // Scope usado finalmente
  retrievalMethods: RetrievalMethod[] // Métodos de retrieval aplicados
  noCandidates: boolean // true si candidates vacío tras aplicar scope
}

/**
 * Resultado de una query individual
 */
export interface CatalogSearchResult {
  queryId: string
  query: {
    q?: string | null
    barcode?: string | null
  }
  candidates: ProductSummary[]
  meta: CatalogSearchResultMeta
}

/**
 * Response del batch catalog search
 */
export interface BatchCatalogSearchResponse {
  success: boolean
  results: CatalogSearchResult[]
  meta: {
    totalQueries: number
    avgCandidatesPerQuery: number
    executionTimeMs: number
  }
}
