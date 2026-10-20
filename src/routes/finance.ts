/**
 * Finance routes — mounts at /finance (auto-loaded by routes/index.ts).
 *
 * Spec §7.6: fine-grained role matrix deferred — reuse read_cashflow for all
 * finance endpoints in this iteration (including CU-012 rules update).
 */

import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { checkPermission } from '../middleware/checkPermission'
import {
  getDashboard,
  getRules,
  updateRules,
  exportReportPdf
} from '../controllers/finance'

const router = Router()

const jwt = (req: any, res: any, next: any): void => { void checkJwt(req, res, next) }
const canRead = (req: any, res: any, next: any): void => {
  void checkPermission('read_cashflow')(req, res, next)
}

router.get('/dashboard', jwt, canRead, (req, res) => { void getDashboard(req, res) })
router.get('/rules', jwt, canRead, (req, res) => { void getRules(req, res) })
router.put('/rules', jwt, canRead, (req, res) => { void updateRules(req, res) })
router.get('/report.pdf', jwt, canRead, (req, res) => { void exportReportPdf(req, res) })

export { router }
