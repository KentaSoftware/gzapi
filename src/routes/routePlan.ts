import { Router } from 'express'
import { getCandidateItems } from '../controllers/routePlan'
import { checkPermission } from '../middleware/checkPermission'
import { checkJwt } from '../middleware/session'

const router = Router()

router.get('/candidates', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_route_plan')(req, res, next) }, (req, res) => { void getCandidateItems(req, res) })

export { router }
