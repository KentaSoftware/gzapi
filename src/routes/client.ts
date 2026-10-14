import { NextFunction, Request, Response, Router } from 'express'
import { confirmLocationItem, geocodeItem, getItem, getItems, postItem, uptdateItem } from '../controllers/client'
import { checkJwt } from '../middleware/session'
import { checkPermission } from '../middleware/checkPermission'

const router = Router()

const authenticate = (req: Request, res: Response, next: NextFunction): void => {
  void checkJwt(req, res, () => {
    const authenticatedRequest = req as Request & { user?: { id?: unknown } }
    if (typeof authenticatedRequest.user?.id === 'string') res.locals.userId = authenticatedRequest.user.id
    next()
  })
}

router.post('/skip', authenticate, (req, res, next) => { void checkPermission('read_client')(req, res, next) }, (req, res) => { void getItems(req, res) })
router.post('/search', authenticate, (req, res, next) => { void checkPermission('read_client')(req, res, next) }, (req, res) => { void getItems(req, res) })
router.get('/', authenticate, (req, res, next) => { void checkPermission('read_client')(req, res, next) }, (req, res) => { void getItems(req, res) })
router.get('/:id', authenticate, (req, res, next) => { void checkPermission('read_client')(req, res, next) }, (req, res) => { void getItem(req, res) })
router.post('/', authenticate, (req, res, next) => { void checkPermission('create_client')(req, res, next) }, (req, res) => { void postItem(req, res) })
router.post('/:id/geocode', authenticate, (req, res) => { void geocodeItem(req, res) })
router.post('/:id/location-confirmation', authenticate, (req, res) => { void confirmLocationItem(req, res) })
router.patch('/:id', authenticate, (req, res, next) => { void checkPermission('update_client')(req, res, next) }, (req, res) => { void uptdateItem(req, res) })

export { router }
