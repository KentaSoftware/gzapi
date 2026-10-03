import { Router } from 'express'
import { annuallyCtrl, bestSellingCtrl, customCtrl, dailyCtrl, dataProductCtrl, highProfitCtrl, monthlyCtrl, weeklyCtrl } from '../controllers/dataset'
import { checkJwt } from '../middleware/session'
import { checkPermission } from '../middleware/checkPermission'

const router = Router()

router.get('/daily', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_dataset')(req, res, next) }, (req, res) => { void dailyCtrl(req, res) })
router.get('/weekly', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_dataset')(req, res, next) }, (req, res) => { void weeklyCtrl(req, res) })
router.get('/monthly', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_dataset')(req, res, next) }, (req, res) => { void monthlyCtrl(req, res) })
router.get('/annually', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_dataset')(req, res, next) }, (req, res) => { void annuallyCtrl(req, res) })
router.get('/bestSelling', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_dataset')(req, res, next) }, (req, res) => { void bestSellingCtrl(req, res) })
router.get('/highProfit', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_dataset')(req, res, next) }, (req, res) => { void highProfitCtrl(req, res) })
router.get('/dataProduct', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_dataset')(req, res, next) }, (req, res) => { void dataProductCtrl(req, res) })
router.get('/custom/:from/:to', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_dataset')(req, res, next) }, (req, res) => { void customCtrl(req, res) })

export { router }
