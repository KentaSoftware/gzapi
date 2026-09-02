import { Router } from 'express'
import { loginCtrl, registerCtrl } from '../controllers/auth'
import { checkJwt } from '../middleware/session'
import { checkPermission } from '../middleware/checkPermission'

const router = Router()

// eslint-disable-next-line @typescript-eslint/no-misused-promises
router.post('/register', checkJwt, checkPermission('create_user'), registerCtrl)
// eslint-disable-next-line @typescript-eslint/no-misused-promises
router.post('/login', loginCtrl)

export { router }
