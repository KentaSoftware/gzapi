import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { deleteItem, getAllItems, getImage, getItem, getItems, getNothing, getUltimasFechasProducto, postItem, printList, printListWithDiscount, uptdateItem, uptdateItems } from '../controllers/product'
import { checkPermission } from '../middleware/checkPermission'
/* import multerMiddleware, { compressImage } from '../middleware/file' */

const router = Router()

router.get('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_product')(req, res, next) }, (req, res) => { void getItem(req, res) })
router.get('/', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_product')(req, res, next) }, (req, res) => { void getAllItems(req, res) })
router.post('/skip', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_product')(req, res, next) }, (req, res) => { void getItems(req, res) })
router.post('/search', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_product')(req, res, next) }, (req, res) => { void getItems(req, res) })
router.post('/', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('create_product')(req, res, next) }, (req, res) => { void postItem(req, res) }) // este
/* router.post('/uploadImage', multerMiddleware.single('myfile'), compressImage, uploadImage) */
router.get('/image/:image', (req, res) => { void getImage(req, res) })
router.get('/active', (req, res) => { void getNothing(req, res) })
router.patch('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('update_product')(req, res, next) }, (req, res) => { void uptdateItem(req, res) }) // este
router.patch('/', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('update_product')(req, res, next) }, (req, res) => { void uptdateItems(req, res) })
router.delete('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('delete_product')(req, res, next) }, deleteItem)
router.post('/print/print', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_product')(req, res, next) }, (req, res) => { void printList(req, res) })
router.post('/print/print-with-discount', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_product')(req, res, next) }, (req, res) => { void printListWithDiscount(req, res) })
router.get('/get/ultimas-fechas', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_product')(req, res, next) }, (req, res) => { void getUltimasFechasProducto(req, res) })

export { router }
