import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { getItem, getItems, postItem, updateItem } from '../controllers/buy'
import { checkPermission } from '../middleware/checkPermission'

const router = Router()

router.get('/', checkJwt, checkPermission('read_buy'), getItems)
router.post('/skip', checkJwt, checkPermission('read_buy'), getItems)
router.post('/search', checkJwt, checkPermission('read_buy'), getItems)
router.get('/:id', checkJwt, checkPermission('read_buy'), getItem)
router.post('/', checkJwt, checkPermission('create_buy'), postItem)
router.patch('/:id', checkJwt, checkPermission('update_buy'), updateItem)

export { router }
