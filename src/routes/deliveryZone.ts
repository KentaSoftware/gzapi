import { Router } from 'express'
import { getItems, patchItem, postItem } from '../controllers/deliveryZone'
import { checkPermission } from '../middleware/checkPermission'
import { checkJwt } from '../middleware/session'

const router = Router()

router.get('/', (req, res, next) => { void checkJwt(req, res, next) }, (req, res) => { void getItems(req, res) })
router.post('/', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('manage_delivery_zone')(req, res, next) }, (req, res) => { void postItem(req, res) })
router.patch('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('manage_delivery_zone')(req, res, next) }, (req, res) => { void patchItem(req, res) })

export { router }
