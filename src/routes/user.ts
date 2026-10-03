import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { checkPermission } from '../middleware/checkPermission'
import { deleteItem, getItem, getItems, updateItem, getAllItems } from '../controllers/user'

const router = Router()

router.get('/', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_user')(req, res, next) }, (req, res) => { void getItems(req, res) })
router.get('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_user')(req, res, next) }, (req, res) => { void getItem(req, res) })
router.get('/get/all', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_user')(req, res, next) }, (req, res) => { void getAllItems(req, res) })
router.post('/skip', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_user')(req, res, next) }, (req, res) => { void getItems(req, res) })
router.post('/search', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_user')(req, res, next) }, (req, res) => { void getItems(req, res) })
router.patch('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('update_user')(req, res, next) }, (req, res) => { void updateItem(req, res) })
router.delete('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('delete_user')(req, res, next) }, (req, res) => { void deleteItem(req, res) })

export { router }
