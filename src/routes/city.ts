import { Router } from 'express'
import { getItem, getItems, postItem, uptdateItem } from '../controllers/city'
import { checkJwt } from '../middleware/session'
import { checkPermission } from '../middleware/checkPermission'

const router = Router()

router.get('/', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_client')(req, res, next) }, (req, res) => { void getItems(req, res) })
router.get('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_client')(req, res, next) }, (req, res) => { void getItem(req, res) })
router.post('/', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('create_client')(req, res, next) }, (req, res) => { void postItem(req, res) })
router.patch('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('update_client')(req, res, next) }, (req, res) => { void uptdateItem(req, res) })

export { router }
