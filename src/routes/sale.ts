import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { getItem, getItems, postItem, postMultipleItem, printSale, printSales, updateItem } from '../controllers/sale'
import { checkPermission } from '../middleware/checkPermission'

const router = Router()

router.get('/', checkJwt, checkPermission('read_sale'), getItems)
router.post('/skip', checkJwt, checkPermission('read_sale'), getItems)
router.post('/search', checkJwt, checkPermission('read_sale'), getItems)
router.get('/:id', checkJwt, checkPermission('read_sale'), getItem)
router.post('/', checkJwt, checkPermission('create_sale'), postItem)
router.post('/multiple', checkJwt, checkPermission('create_sale'), postMultipleItem)
router.patch('/:id', checkJwt, checkPermission('update_sale'), updateItem)
router.get('/print/:id', checkJwt, checkPermission('read_sale'), printSale)
router.post('/print', checkJwt, checkPermission('read_sale'), printSales)

export { router }
