import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { deleteItem, getItem, getItems, getListBuyAvgCtrl, getListBuyByDateRangeCtrl, patchItem, postItem } from '../controllers/itemSale'
import { checkPermission } from '../middleware/checkPermission'

const router = Router()

router.get('/', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_sale')(req, res, next) }, (req, res) => { void getItems(req, res) })
router.get('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_sale')(req, res, next) }, (req, res) => { void getItem(req, res) })
router.post('/', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('create_sale')(req, res, next) }, (req, res) => { void postItem(req, res) })
router.patch('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('update_sale')(req, res, next) }, (req, res) => { void patchItem(req, res) })
router.delete('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('delete_sale')(req, res, next) }, (req, res) => { void deleteItem(req, res) })
router.get('/listbuy/:start/:end/:prov', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_sale')(req, res, next) }, (req, res) => { void getListBuyByDateRangeCtrl(req, res) })
router.get('/listbuyavg/:prov', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_sale')(req, res, next) }, (req, res) => { void getListBuyAvgCtrl(req, res) })

export { router }
