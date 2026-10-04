import { Router } from 'express'
import { loginCtrl, registerCtrl } from '../controllers/auth'
import { checkJwt } from '../middleware/session'
import { checkPermission } from '../middleware/checkPermission'

const router = Router()

router.post('/register', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('create_user')(req, res, next) }, (req, res) => { void registerCtrl(req, res) })
router.post('/login', (req, res) => { void loginCtrl(req, res) })

export { router }
