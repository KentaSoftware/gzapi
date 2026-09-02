import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { deleteItem, getItem, getItems, getListBuyAvgCtrl, getListBuyByDateRangeCtrl, patchItem, postItem } from '../controllers/itemSale'
import { checkPermission } from '../middleware/checkPermission'

const router = Router()

router.get('/', checkJwt, checkPermission('read_sale'), getItems)
router.get('/:id', checkJwt, checkPermission('read_sale'), getItem)
router.post('/', checkJwt, checkPermission('create_sale'), postItem)
router.patch('/:id', checkJwt, checkPermission('update_sale'), patchItem)
router.delete('/:id', checkJwt, checkPermission('delete_sale'), deleteItem)
router.get('/listbuy/:start/:end/:prov', checkJwt, checkPermission('read_sale'), getListBuyByDateRangeCtrl)
router.get('/listbuyavg/:prov', checkJwt, checkPermission('read_sale'), getListBuyAvgCtrl)

export { router }
