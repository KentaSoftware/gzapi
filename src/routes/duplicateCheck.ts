import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { checkPermission } from '../middleware/checkPermission'
import {
  checkDuplicate,
  registerDecision,
  getCheckHistory
} from '../controllers/duplicateCheck'

const router = Router()

/**
 * NOTA: Este router se monta en /duplicateCheck por el sistema de auto-carga
 * Para acceder: POST /duplicateCheck/drafts/:draftId/check
 *
 * Si se requiere el path /purchase-docs/*, registrar manualmente en routes/index.ts
 */

/**
 * @route   POST /duplicateCheck/drafts/:draftId/check
 * @desc    Verifica si existe un posible duplicado
 * @access  Private - Requiere read_buy permission
 * @body    CheckDuplicateRequestDTO
 *          - providerId: string (required)
 *          - date: string (required, format: YYYY-MM-DD)
 *          - total: number (required)
 *          - docNumber: string (optional)
 *          - fingerprint: string (optional)
 *          - tolerance: { days?, totalPct?, totalAbs? } (optional)
 * @response 200 CheckDuplicateResponseDTO
 *          - isPossibleDuplicate: boolean
 *          - criteriaTriggered: DuplicateCriteria[]
 *          - candidates: DuplicateCandidate[]
 *          - recommendation: "PROMPT_USER" | "NO_PROMPT"
 *          - checkId: string
 */
router.post(
  '/drafts/:draftId/check',
  (req, res, next) => { void checkJwt(req, res, next) },
  (req, res, next) => { void checkPermission('read_buy')(req, res, next) },
  (req, res) => { void checkDuplicate(req, res) }
)

/**
 * @route   POST /duplicateCheck/drafts/:draftId/decision
 * @desc    Registra la decisión del usuario ante advertencia de duplicado
 * @access  Private - Requiere create_buy permission
 * @body    DuplicateDecisionRequestDTO
 *          - decision: "CANCEL" | "CONTINUE" (required)
 *          - selectedExistingBuyId: string (optional)
 *          - criteriaTriggered: DuplicateCriteria[] (required)
 *          - candidates: DuplicateCandidate[] (required)
 * @response 200 DuplicateDecisionResponseDTO
 *          - success: boolean
 *          - message: string
 *          - checkId: string
 */
router.post(
  '/drafts/:draftId/decision',
  (req, res, next) => { void checkJwt(req, res, next) },
  (req, res, next) => { void checkPermission('create_buy')(req, res, next) },
  (req, res) => { void registerDecision(req, res) }
)

/**
 * @route   GET /duplicateCheck/drafts/:draftId/checks
 * @desc    Obtiene el historial de checks de duplicado para un draft
 * @access  Private - Requiere read_buy permission
 * @response 200
 *          - success: boolean
 *          - count: number
 *          - checks: PurchaseDocDuplicateCheck[]
 */
router.get(
  '/drafts/:draftId/checks',
  (req, res, next) => { void checkJwt(req, res, next) },
  (req, res, next) => { void checkPermission('read_buy')(req, res, next) },
  (req, res) => { void getCheckHistory(req, res) }
)

export { router }
