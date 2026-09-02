import { Types } from 'mongoose'

/**
 * Estado del draft de documento de compra
 */
export enum DraftStatus {
  PROCESSING = 'PROCESSING', // Análisis en progreso
  READY = 'READY', // Análisis completo, listo para confirmar
  FAILED = 'FAILED', // Análisis falló
  CONFIRMED = 'CONFIRMED' // Confirmado como compra definitiva
}

/**
 * Tipo de documento fuente
 */
export enum SourceType {
  INVOICE = 'invoice', // Factura
  RECEIPT = 'receipt', // Remito
  BUDGET = 'budget' // Presupuesto
}

/**
 * Metadata del archivo cargado
 */
export interface FileMetadata {
  filename: string // Nombre generado único
  originalName: string // Nombre original del archivo
  path: string // Ruta relativa: /uploads/purchase-docs/xxx.jpg
  mimeType: string // image/jpeg, image/png, application/pdf, etc.
  size: number // Tamaño en bytes
}

/**
 * Header del documento analizado
 */
export interface AnalyzedHeader {
  documentNumber?: string
  documentDate?: string // YYYY-MM-DD
  providerName?: string
  providerId?: string
  total?: number
  confidence?: number
}

/**
 * Match de catálogo para un item
 */
export interface CatalogMatch {
  productId: string
  description: string
  confidence: number
  method: string // BARCODE_EXACT, TEXT_FUZZY, etc.
  source: string // LOCAL_CACHE, BATCH_SEARCH_PROVIDER_FIRST, etc.
  candidates?: Array<{
    productId: string
    description: string
    score: number
  }>
}

/**
 * Item analizado del documento
 */
export interface AnalyzedItem {
  itemId: string
  description: string
  quantity: number
  unitPrice: number
  subtotal: number
  barcode?: string
  catalogMatch?: CatalogMatch
}

/**
 * Metadata del análisis
 */
export interface AnalysisMeta {
  itemsProcessed: number
  itemsWithMatch: number
  itemsWithoutMatch: number
  avgConfidence?: number
  processingTime?: number
  cacheVersion?: string
  batchSearchUsed?: boolean
}

/**
 * Resultado completo del análisis de Document AI
 */
export interface AnalyzeResult {
  header: AnalyzedHeader
  items: AnalyzedItem[]
  meta: AnalysisMeta
}

/**
 * Candidato de duplicado detectado
 */
export interface DuplicateCandidate {
  purchaseId: string
  documentNumber?: string
  documentDate?: string
  providerId?: string
  total: number
  createdAt: Date
  score: number
  reasons: Array<{
    strategy: string
    match: boolean
    score: number
    boost?: number
  }>
}

/**
 * Posible duplicado detectado
 */
export interface PossibleDuplicate {
  checkId: string
  status: 'CLEAN' | 'SUSPECTED_DUPLICATE'
  duplicates: DuplicateCandidate[]
  canProceed: boolean
  requiresDecision: boolean
  message: string
}

/**
 * Error de análisis
 */
export interface AnalysisError {
  message: string
  stack?: string
  code?: string
}

/**
 * Draft de documento de compra (documento sin confirmar)
 */
export interface DraftPurchaseDoc {
  _id?: Types.ObjectId
  file: FileMetadata
  providerId?: Types.ObjectId
  sourceType: SourceType
  userId: Types.ObjectId
  status: DraftStatus
  analysisResult?: AnalyzeResult
  possibleDuplicate?: PossibleDuplicate
  error?: AnalysisError
  confirmedBuyId?: Types.ObjectId
  confirmedAt?: Date
  createdAt?: Date
  updatedAt?: Date
}

/**
 * DTO para respuesta de upload
 */
export interface CreateDraftUploadResponse {
  draftId: string
  status: DraftStatus
  file: FileMetadata
  providerId?: string
  sourceType: SourceType
  analysis?: AnalyzeResult
  possibleDuplicate?: PossibleDuplicate
  error?: AnalysisError
}

/**
 * DTO para ediciones del header en confirm
 */
export interface HeaderEdits {
  providerId?: string
  documentDate?: string
  documentNumber?: string
  total?: number
}

/**
 * Producto nuevo a crear durante confirmación
 */
export interface NewProductData {
  descripcion: string
  categoria: string
  marca: string
  proveedor: string
  codigoBarra?: string
  precioCompra?: number
  precioUnitario?: number
  stock?: number
  bulto?: number
  precioBulto?: number
}

/**
 * Item para confirmación con ediciones
 */
export interface ConfirmItem {
  lineId: string // itemId del análisis
  chosenProductId?: string // ID del producto elegido
  newProduct?: NewProductData // O datos para crear producto nuevo
  quantity?: number // Override de cantidad
  unitPrice?: number // Override de precio unitario
  subtotal?: number // Override de subtotal
}

/**
 * Decisión sobre duplicado
 */
export interface DuplicateDecisionData {
  checkId?: string
  decision?: 'CANCEL' | 'PROCEED'
  reason?: string
}

/**
 * Request para confirmar draft
 */
export interface ConfirmPurchaseDocRequest {
  headerEdits?: HeaderEdits
  items: ConfirmItem[]
  duplicateDecision?: DuplicateDecisionData
}

/**
 * Response de confirmación
 */
export interface ConfirmPurchaseDocResponse {
  success: boolean
  data: {
    buyId: string
    draftId: string
    status: DraftStatus
  }
}
