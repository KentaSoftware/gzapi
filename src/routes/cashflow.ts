/**
 * Cashflow routes — TICKET-004: cash-flow-real-v1
 *
 * Auto-loaded by src/routes/index.ts → mounts at /cashflow
 * (no /api global prefix — confirmed by gzapi/AGENTS.md and T001.5)
 *
 * Auth pattern: checkJwt + checkPermission (same as expense.ts, buy.ts)
 *  - read_cashflow  → GET /cashflow/summary, /timeline, /movements, /config
 *  - configure_cashflow → PUT /cashflow/config
 */

import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { checkPermission } from '../middleware/checkPermission'
import {
  getSummary,
  getTimeline,
  getMovements,
  getConfig,
  updateConfig
} from '../controllers/cashflow'

const router = Router()

router.get('/summary', checkJwt, checkPermission('read_cashflow'), getSummary)
router.get('/timeline', checkJwt, checkPermission('read_cashflow'), getTimeline)
router.get('/movements', checkJwt, checkPermission('read_cashflow'), getMovements)
router.get('/config', checkJwt, checkPermission('read_cashflow'), getConfig)
router.put('/config', checkJwt, checkPermission('configure_cashflow'), updateConfig)

export { router }
