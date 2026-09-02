import { Router } from "express"
import { getItem, getItems, postItem, uptdateItem } from "../controllers/client"
import { checkJwt } from "../middleware/session"
import { checkPermission } from "../middleware/checkPermission"

const router = Router()

router.post('/skip', checkJwt, checkPermission('read_client'), getItems)
router.post('/search', checkJwt, checkPermission('read_client'), getItems)
router.get('/', checkJwt, checkPermission('read_client'), getItems)
router.get('/:id', checkJwt, checkPermission('read_client'), getItem)
router.post('/', checkJwt, checkPermission('create_client'), postItem)
router.patch('/:id', checkJwt, checkPermission('update_client'), uptdateItem)

export { router }