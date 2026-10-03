import { Router } from 'express'
import { backupCtrl, restoreCtrl } from '../controllers/backup'

const router = Router()

router.get('/', (req, res) => { void backupCtrl(req, res) })
router.get('/restore', (req, res) => { void restoreCtrl(req, res) })

export { router }
