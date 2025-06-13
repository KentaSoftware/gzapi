import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { deleteItem, getAllItems, getImage, getItem, getItems, getNothing, postItem, printList, printListWithDiscount, uptdateItem, uptdateItems } from '../controllers/product'
import { checkPermission } from '../middleware/checkPermission'
/* import multerMiddleware, { compressImage } from '../middleware/file' */

const router = Router()

router.get('/:id', checkJwt, checkPermission('read_product'), getItem)
router.get('/', checkJwt, checkPermission('read_product'), getAllItems)
router.post('/skip', checkJwt, checkPermission('read_product'), getItems)
router.post('/search', checkJwt, checkPermission('read_product'), getItems)
router.post('/', checkJwt, checkPermission('create_product'), postItem) //este
/* router.post('/uploadImage', multerMiddleware.single('myfile'), compressImage, uploadImage) */
router.get('/image/:image', getImage)
router.get('/active', getNothing)
router.patch('/:id', checkJwt, checkPermission('update_product'), uptdateItem) //este
router.patch('/', checkJwt, checkPermission('update_product'), uptdateItems)
router.delete('/:id', checkJwt, checkPermission('delete_product'), deleteItem)
router.post('/print/print', checkJwt, checkPermission('read_product'), printList)
router.post('/print/print-with-discount', checkJwt, checkPermission('read_product'), printListWithDiscount)


export { router }
