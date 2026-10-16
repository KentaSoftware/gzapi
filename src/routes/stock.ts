import { Router } from 'express'

import { checkPermission } from '../middleware/checkPermission'
import { checkJwt } from '../middleware/session'
import {
  getAvailability,
  getOverview,
  getProductDetail,
  confirmOpeningCount,
  previewOpeningCount,
  receivePurchase,
  removeExpiredBucket,
  returnSale,
  updateMinimum
} from '../controllers/stock'

const router = Router()

router.get('/availability', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_stock')(req, res, next) }, (req, res) => { void getAvailability(req, res) })
router.get('/overview', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_stock')(req, res, next) }, (req, res) => { void getOverview(req, res) })
router.get('/products/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_stock')(req, res, next) }, (req, res) => { void getProductDetail(req, res) })
router.patch('/products/:id/minimum', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('manage_stock_config')(req, res, next) }, (req, res) => { void updateMinimum(req, res) })
router.post('/opening-counts/preview', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('manage_stock_config')(req, res, next) }, (req, res) => { void previewOpeningCount(req, res) })
router.post('/opening-counts/confirm', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('manage_stock_config')(req, res, next) }, (req, res) => { void confirmOpeningCount(req, res) })
router.post('/purchases/:buyId/receive', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('receive_stock')(req, res, next) }, (req, res) => { void receivePurchase(req, res) })
router.post('/returns', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('manage_stock')(req, res, next) }, (req, res) => { void returnSale(req, res) })
router.post('/expired-buckets/:id/remove', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('manage_stock')(req, res, next) }, (req, res) => { void removeExpiredBucket(req, res) })

export { router }
