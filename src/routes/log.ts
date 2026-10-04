import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { getItems } from '../controllers/log'
import { checkPermission } from '../middleware/checkPermission'

const router = Router()

router.post('/', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_log')(req, res, next) }, (req, res) => { void getItems(req, res) })

export { router }
