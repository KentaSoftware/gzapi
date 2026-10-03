import { Router } from 'express'
import { getItem } from '../controllers/ping'

const router = Router()

router.get('/', (req, res) => { void getItem(req, res) })

export { router }
