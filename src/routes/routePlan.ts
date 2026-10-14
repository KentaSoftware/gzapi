import { NextFunction, Request, Response, Router } from 'express'
import { getCandidateItems, getRouteAssignmentOptions, getRouteConfig, getRoutePlanById, getRoutePlans, getRouteDashboard, patchRouteConfig, patchRoutePlanOperational, previewRoute, saveRoutePlan } from '../controllers/routePlan'
import { checkJwt } from '../middleware/session'

const router = Router()

const authenticate = (req: Request, res: Response, next: NextFunction): void => {
  void checkJwt(req, res, () => {
    const authenticatedRequest = req as Request & { user?: { id?: unknown } }
    if (typeof authenticatedRequest.user?.id === 'string') res.locals.userId = authenticatedRequest.user.id
    next()
  })
}

router.get('/dashboard', authenticate, (req, res) => { void getRouteDashboard(req, res) })
router.get('/candidates', authenticate, (req, res) => { void getCandidateItems(req, res) })
router.get('/assignment-options', authenticate, (req, res) => { void getRouteAssignmentOptions(req, res) })
router.post('/preview', authenticate, (req, res) => { void previewRoute(req, res) })
router.post('/', authenticate, (req, res) => { void saveRoutePlan(req, res) })
router.get('/', authenticate, (req, res) => { void getRoutePlans(req, res) })
router.get('/config', authenticate, (req, res) => { void getRouteConfig(req, res) })
router.patch('/config', authenticate, (req, res) => { void patchRouteConfig(req, res) })
router.patch('/:id/operational', authenticate, (req, res) => { void patchRoutePlanOperational(req, res) })
router.get('/:id', authenticate, (req, res) => { void getRoutePlanById(req, res) })

export { router }
