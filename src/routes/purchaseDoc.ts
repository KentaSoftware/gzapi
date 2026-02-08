import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { checkPermission } from '../middleware/checkPermission'
import {
  uploadPurchaseDoc,
  handleUploadError,
  validateFileExists
} from '../middleware/uploadPurchaseDocs'
import {
  uploadPurchaseDoc as uploadController,
  getDraftStatus,
  listDrafts,
  confirmPurchaseDoc
} from '../controllers/purchaseDoc'

const router = Router()

/**
 * POST /purchase-docs/upload
 * Sube archivo de comprobante, crea draft y procesa análisis
 * Requiere: JWT + create_buy permission
 * Body: multipart/form-data con file, providerId?, sourceType
 */
router.post(
  '/upload',
  checkJwt,
  checkPermission('create_buy'),
  uploadPurchaseDoc, // Multer middleware
  handleUploadError, // Manejo de errores de multer
  validateFileExists, // Validar que archivo existe
  uploadController // Controller
)

/**
 * GET /purchase-docs
 * Lista drafts del usuario con filtros opcionales
 * Requiere: JWT + read_buy permission
 * Query params: skip?, limit?, status?
 */
router.get(
  '/',
  checkJwt,
  checkPermission('read_buy'),
  listDrafts
)

/**
 * GET /purchase-docs/:draftId
 * Obtiene estado actual de un draft (para polling)
 * Requiere: JWT + read_buy permission
 */
router.get(
  '/:draftId',
  checkJwt,
  checkPermission('read_buy'),
  getDraftStatus
)

/**
 * POST /purchase-docs/:draftId/confirm
 * Confirma draft y crea compra definitiva
 * Requiere: JWT + create_buy permission
 * Body: { headerEdits?, items, duplicateDecision? }
 */
router.post(
  '/:draftId/confirm',
  checkJwt,
  checkPermission('create_buy'),
  confirmPurchaseDoc
)

export { router }
