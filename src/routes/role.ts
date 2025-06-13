import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { checkPermission } from '../middleware/checkPermission'
import { deleteItem, getItem, getItems, createItem, updateItem } from '../controllers/role'

const router = Router()

router.get('/', checkJwt, checkPermission('read_role'), getItems)
router.get('/:id', checkJwt, checkPermission('read_role'), getItem)
router.post('/skip', checkJwt, checkPermission('read_role'), getItems)
router.post('/search', checkJwt, checkPermission('read_role'), getItems)
router.post('/', checkJwt, checkPermission('create_role'), createItem)
router.patch('/:id', checkJwt, checkPermission('update_role'), updateItem)
router.delete('/:id', checkJwt, checkPermission('delete_role'), deleteItem)

export { router } 