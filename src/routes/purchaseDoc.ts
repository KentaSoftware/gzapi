import { NextFunction, Request, Response, Router } from 'express'
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
  (req: Request, res: Response, next: NextFunction) => { void checkJwt(req, res, next) },
  (req: Request, res: Response, next: NextFunction) => { void checkPermission('create_buy')(req, res, next) },
  uploadPurchaseDoc, // Multer middleware
  handleUploadError, // Manejo de errores de multer
  validateFileExists, // Validar que archivo existe
  (req: Request, res: Response) => { void uploadController(req, res) } // Controller
)

/**
 * GET /purchase-docs
 * Lista drafts del usuario con filtros opcionales
 * Requiere: JWT + read_buy permission
 * Query params: skip?, limit?, status?
 */
router.get(
  '/',
  (req, res, next) => { void checkJwt(req, res, next) },
  (req, res, next) => { void checkPermission('read_buy')(req, res, next) },
  (req, res) => { void listDrafts(req, res) }
)

/**
 * GET /purchase-docs/:draftId
 * Obtiene estado actual de un draft (para polling)
 * Requiere: JWT + read_buy permission
 */
router.get(
  '/:draftId',
  (req, res, next) => { void checkJwt(req, res, next) },
  (req, res, next) => { void checkPermission('read_buy')(req, res, next) },
  (req, res) => { void getDraftStatus(req, res) }
)

/**
 * POST /purchase-docs/:draftId/confirm
 * Confirma draft y crea compra definitiva
 * Requiere: JWT + create_buy permission
 * Body: { headerEdits?, items, duplicateDecision? }
 */
router.post(
  '/:draftId/confirm',
  (req, res, next) => { void checkJwt(req, res, next) },
  (req, res, next) => { void checkPermission('create_buy')(req, res, next) },
  (req, res) => { void confirmPurchaseDoc(req, res) }
)

export { router }
