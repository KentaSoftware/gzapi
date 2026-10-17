import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { patchItemBuy } from '../controllers/buy'
import { checkPermission } from '../middleware/checkPermission'

const router = Router()

router.patch('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('update_buy')(req, res, next) }, (req, res) => { void patchItemBuy(req, res) })

export { router }
