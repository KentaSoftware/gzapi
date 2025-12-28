import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { checkPermission } from '../middleware/checkPermission'
import {
  getCatalogVersion,
  getCatalogSnapshot,
  searchProducts,
  getAllProvidersWithVersion
} from '../controllers/catalog'

const router = Router()

/**
 * @route   GET /catalog/providers
 * @desc    Obtiene todos los proveedores con su versión de catálogo
 * @access  Private (catalog_read)
 */
router.get('/providers', checkJwt, checkPermission('catalog_read'), getAllProvidersWithVersion)

/**
 * @route   GET /catalog/version
 * @desc    Obtiene versión del catálogo de un proveedor
 * @access  Private (catalog_read)
 * @query   providerId - ID del proveedor (required)
 */
router.get('/version', checkJwt, checkPermission('catalog_read'), getCatalogVersion)

/**
 * @route   GET /catalog/snapshot
 * @desc    Obtiene snapshot liviano paginado del catálogo
 * @access  Private (catalog_read)
 * @query   providerId - ID del proveedor (required)
 * @query   limit - Cantidad de productos por página (default: 500, max: 1000)
 * @query   cursor - Cursor para paginación (último productId)
 * @query   version - Versión actual del cliente (para cache validation)
 */
router.get('/snapshot', checkJwt, checkPermission('catalog_read'), getCatalogSnapshot)

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
router.get('/search', checkJwt, checkPermission('catalog_read'), searchProducts)

export { router }
