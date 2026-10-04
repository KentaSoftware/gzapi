import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { checkPermission } from '../middleware/checkPermission'
import { deleteItem, getItem, getItems, createItem, updateItem } from '../controllers/role'

const router = Router()

router.get('/', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_role')(req, res, next) }, (req, res) => { void getItems(req, res) })
router.get('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_role')(req, res, next) }, (req, res) => { void getItem(req, res) })
router.post('/skip', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_role')(req, res, next) }, (req, res) => { void getItems(req, res) })
router.post('/search', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_role')(req, res, next) }, (req, res) => { void getItems(req, res) })
router.post('/', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('create_role')(req, res, next) }, (req, res) => { void createItem(req, res) })
router.patch('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('update_role')(req, res, next) }, (req, res) => { void updateItem(req, res) })
router.delete('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('delete_role')(req, res, next) }, (req, res) => { void deleteItem(req, res) })

export { router }
