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
