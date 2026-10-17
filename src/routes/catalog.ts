import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { checkPermission } from '../middleware/checkPermission'
import {
  getCatalogVersion,
  getCatalogSnapshot,
  searchProducts,
  getAllProvidersWithVersion,
  createOrUpdateAlias,
  confirmMatch,
  batchSearch
} from '../controllers/catalog'

const router = Router()

/**
 * @route   GET /catalog/providers
 * @desc    Obtiene todos los proveedores con su versión de catálogo
 * @access  Private (catalog_read)
 */
router.get('/providers', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('catalog_read')(req, res, next) }, (req, res) => { void getAllProvidersWithVersion(req, res) })

/**
 * @route   GET /catalog/version
 * @desc    Obtiene versión del catálogo de un proveedor
 * @access  Private (catalog_read)
 * @query   providerId - ID del proveedor (required)
 */
router.get('/version', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('catalog_read')(req, res, next) }, (req, res) => { void getCatalogVersion(req, res) })

/**
 * @route   GET /catalog/snapshot
 * @desc    Obtiene snapshot liviano paginado del catálogo
 * @access  Private (catalog_read)
 * @query   providerId - ID del proveedor (required)
 * @query   limit - Cantidad de productos por página (default: 500, max: 1000)
 * @query   cursor - Cursor para paginación (último productId)
 * @query   version - Versión actual del cliente (para cache validation)
 */
router.get('/snapshot', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('catalog_read')(req, res, next) }, (req, res) => { void getCatalogSnapshot(req, res) })

/**
 * @route   GET /catalog/search
 * @desc    Búsqueda de productos para matching
 * @access  Private (catalog_read)
 * @query   q - Texto a buscar en descripción
 * @query   providerId - Filtrar por proveedor (optional)
 * @query   barcode - Buscar por código de barras exacto
 * @query   sku - Buscar por SKU (futuro)
 * @query   limit - Cantidad máxima de resultados (default: 20, max: 100)
 */
router.get('/search', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('catalog_read')(req, res, next) }, (req, res) => { void searchProducts(req, res) })

/**
 * @route   POST /catalog/search/batch
 * @desc    Búsqueda batch de productos con soporte para múltiples queries
 * @access  Private (catalog_read)
 * @body    queries - Array de queries [{ queryId, q?, barcode? }] (1-50 items)
 * @body    providerId - ID del proveedor para búsqueda scoped (optional)
 * @body    scope - PROVIDER_ONLY | GLOBAL_ONLY | PROVIDER_FIRST (default: PROVIDER_FIRST)
 * @body    topK - Cantidad máxima de candidatos por query (default: 20, max: 50)
 * @body    minCandidates - Mínimo de candidatos antes de fallback global (default: 10)
 */
router.post('/search/batch', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('catalog_read')(req, res, next) }, (req, res) => { void batchSearch(req, res) })

/**
 * @route   POST /catalog/aliases
 * @desc    Crea o actualiza un alias de producto
 * @access  Private (catalog_write)
 * @body    providerId - ID del proveedor (required)
 * @body    aliasType - Tipo de alias: DESCRIPTION | BARCODE | SKU (required)
 * @body    aliasValueRaw - Valor original del alias (required)
 * @body    productId - ID del producto al que apunta (required)
 * @body    confidence - Confianza 0-1 (optional, default: 0.95)
 */
router.post('/aliases', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('catalog_write')(req, res, next) }, (req, res) => { void createOrUpdateAlias(req, res) })

/**
 * @route   POST /catalog/matches/confirm
 * @desc    Confirma un matching de ítem y aprende del resultado
 * @access  Private (catalog_write)
 * @body    providerId - ID del proveedor (required)
 * @body    rawDescription - Descripción original del ítem (required)
 * @body    normalizedDescription - Descripción normalizada (optional)
 * @body    productId - ID del producto elegido (required)
 * @body    method - Método de match: EXACT_BARCODE | EXACT_ALIAS | FUZZY_MATCH | MANUAL_SELECTION (required)
 * @body    suggestionScore - Score de la sugerencia 0-1 (optional)
 * @body    suggestionRank - Posición en ranking (optional)
 * @body    detected - Datos detectados: { barcode?, unit?, qty? } (optional)
 * @body    doc - Info del documento: { draftId?, buyId?, date?, total? } (optional)
 */
router.post('/matches/confirm', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('catalog_write')(req, res, next) }, (req, res) => { void confirmMatch(req, res) })

export { router }
