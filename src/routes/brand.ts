import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { deleteItem, getItem, getItems, postItem, uptdateItem } from '../controllers/brand'
import { checkPermission } from '../middleware/checkPermission'

const router = Router()

router.get('/', checkJwt, checkPermission('read_product'), getItems)
router.get('/:id', checkJwt, checkPermission('read_product'), getItem)
router.post('/', checkJwt, checkPermission('create_product'), postItem)
router.patch('/:id', checkJwt, checkPermission('update_product'), uptdateItem)
router.delete('/:id', checkJwt, checkPermission('delete_product'), deleteItem)

export { router }
