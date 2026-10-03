import { Router } from 'express'
import { backupCtrl, restoreCtrl } from '../controllers/backup'

const router = Router()

router.get('/', backupCtrl)
router.get('/restore', restoreCtrl)

export { router }
