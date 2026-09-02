import { Router } from 'express'
import { annuallyCtrl, bestSellingCtrl, customCtrl, dailyCtrl, dataProductCtrl, highProfitCtrl, monthlyCtrl, weeklyCtrl } from '../controllers/dataset'
import { checkJwt } from '../middleware/session'
import { checkPermission } from '../middleware/checkPermission'

const router = Router()

router.get('/daily', checkJwt, checkPermission('read_dataset'), dailyCtrl)
router.get('/weekly', checkJwt, checkPermission('read_dataset'), weeklyCtrl)
router.get('/monthly', checkJwt, checkPermission('read_dataset'), monthlyCtrl)
router.get('/annually', checkJwt, checkPermission('read_dataset'), annuallyCtrl)
router.get('/bestSelling', checkJwt, checkPermission('read_dataset'), bestSellingCtrl)
router.get('/highProfit', checkJwt, checkPermission('read_dataset'), highProfitCtrl)
router.get('/dataProduct', checkJwt, checkPermission('read_dataset'), dataProductCtrl)
router.get('/custom/:from/:to', checkJwt, checkPermission('read_dataset'), customCtrl)

export { router }
