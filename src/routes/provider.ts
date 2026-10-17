import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { deleteItem, getItem, getItems, postItem, uptdateItem } from '../controllers/provider'
import { checkPermission } from '../middleware/checkPermission'

const router = Router()

router.get('/', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_product')(req, res, next) }, (req, res) => { void getItems(req, res) })
router.get('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_product')(req, res, next) }, (req, res) => { void getItem(req, res) })
router.post('/', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('create_product')(req, res, next) }, (req, res) => { void postItem(req, res) })
router.patch('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('update_product')(req, res, next) }, (req, res) => { void uptdateItem(req, res) })
router.delete('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('delete_product')(req, res, next) }, deleteItem)

export { router }
