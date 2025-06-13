import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { checkPermission } from '../middleware/checkPermission'
import { deleteItem, getItem, getItems, updateItem } from '../controllers/user'

const router = Router()

router.get('/', checkJwt, checkPermission('read_user'), getItems)
router.get('/:id', checkJwt, checkPermission('read_user'), getItem)
router.post('/skip', checkJwt, checkPermission('read_user'), getItems)
router.post('/search', checkJwt, checkPermission('read_user'), getItems)
router.patch('/:id', checkJwt, checkPermission('update_user'), updateItem)
router.delete('/:id', checkJwt, checkPermission('delete_user'), deleteItem)

export { router } 