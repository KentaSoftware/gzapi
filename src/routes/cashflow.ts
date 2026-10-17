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

router.get('/summary', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_cashflow')(req, res, next) }, (req, res) => { void getSummary(req, res) })
router.get('/timeline', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_cashflow')(req, res, next) }, (req, res) => { void getTimeline(req, res) })
router.get('/movements', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_cashflow')(req, res, next) }, (req, res) => { void getMovements(req, res) })
router.get('/config', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_cashflow')(req, res, next) }, (req, res) => { void getConfig(req, res) })
router.put('/config', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('configure_cashflow')(req, res, next) }, (req, res) => { void updateConfig(req, res) })

export { router }
