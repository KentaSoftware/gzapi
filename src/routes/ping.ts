import { Router } from 'express'
import { getItem } from '../controllers/ping'

const router = Router()

router.get('/', getItem)

export { router }
