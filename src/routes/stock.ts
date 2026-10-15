import { Router } from 'express'

import { checkPermission } from '../middleware/checkPermission'
import { checkJwt } from '../middleware/session'
import {
  getAvailability,
  receivePurchase,
  removeExpiredBucket,
  returnSale
} from '../controllers/stock'

const router = Router()

router.get('/availability', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_stock')(req, res, next) }, (req, res) => { void getAvailability(req, res) })
router.post('/purchases/:buyId/receive', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('receive_stock')(req, res, next) }, (req, res) => { void receivePurchase(req, res) })
router.post('/returns', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('manage_stock')(req, res, next) }, (req, res) => { void returnSale(req, res) })
router.post('/expired-buckets/:id/remove', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('manage_stock')(req, res, next) }, (req, res) => { void removeExpiredBucket(req, res) })

export { router }
