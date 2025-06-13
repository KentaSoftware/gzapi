import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { patchItemBuy } from '../controllers/buy'
import { checkPermission } from '../middleware/checkPermission'

const router = Router()

router.patch('/:id', checkJwt, checkPermission('update_buy'), patchItemBuy)

export { router }
