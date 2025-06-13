import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { deleteItem, getItem, getItems, postItem, uptdateItem } from '../controllers/provider'
import { checkPermission } from '../middleware/checkPermission'

const router = Router()

router.get('/', checkJwt, checkPermission('read_provider'), getItems)
router.get('/:id', checkJwt, checkPermission('read_provider'), getItem)
router.post('/', checkJwt, checkPermission('create_provider'), postItem)
router.patch('/:id', checkJwt, checkPermission('update_provider'), uptdateItem)
router.delete('/:id', checkJwt, checkPermission('delete_provider'), deleteItem)

export { router }
