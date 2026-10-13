import { Router } from 'express'
import { getCandidateItems, getRouteConfig, getRoutePlanById, getRoutePlans, getRouteDashboard, patchRouteConfig, previewRoute, saveRoutePlan } from '../controllers/routePlan'
import { checkPermission } from '../middleware/checkPermission'
import { checkJwt } from '../middleware/session'

const router = Router()

router.get('/dashboard', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_route_plan')(req, res, next) }, (req, res) => { void getRouteDashboard(req, res) })
router.get('/candidates', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_route_plan')(req, res, next) }, (req, res) => { void getCandidateItems(req, res) })
router.post('/preview', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('create_route_plan')(req, res, next) }, (req, res) => { void previewRoute(req, res) })
router.post('/', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('create_route_plan')(req, res, next) }, (req, res) => { void saveRoutePlan(req, res) })
router.get('/', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_route_plan')(req, res, next) }, (req, res) => { void getRoutePlans(req, res) })
router.get('/config', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('manage_route_config')(req, res, next) }, (req, res) => { void getRouteConfig(req, res) })
router.patch('/config', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('manage_route_config')(req, res, next) }, (req, res) => { void patchRouteConfig(req, res) })
router.get('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_route_plan')(req, res, next) }, (req, res) => { void getRoutePlanById(req, res) })

export { router }
