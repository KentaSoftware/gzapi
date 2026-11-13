import { NextFunction, Request, Response, Router } from 'express'
import { applyAssignmentIndexMigration, getCandidateItems, getRouteAssignmentOptions, getRouteConfig, getRoutePlanById, getRoutePlans, getRouteDashboard, patchRouteConfig, patchRoutePlanOperational, preflightAssignmentIndexMigration, previewRoute, saveRoutePlan } from '../controllers/routePlan'
import { checkJwt } from '../middleware/session'
import { checkPermission } from '../middleware/checkPermission'
import { sendErrorEnvelope } from '../utils/error.handle'

const router = Router()

const authenticate = (req: Request, res: Response, next: NextFunction): void => {
  void checkJwt(req, res, () => {
    const authenticatedRequest = req as Request & { user?: { id?: unknown, role?: { name?: unknown } } }
    if (typeof authenticatedRequest.user?.id !== 'string' || authenticatedRequest.user.id === '' || typeof authenticatedRequest.user.role?.name !== 'string' || authenticatedRequest.user.role.name === '') {
      sendErrorEnvelope(res, 403, 'PERMISSION_DENIED', 'Permission is denied')
      return
    }
    res.locals.userId = authenticatedRequest.user.id
    next()
  })
}

const authorize = (permission: string): ((req: Request, res: Response, next: NextFunction) => void) => {
  const middleware = checkPermission(permission, { currentRole: true })
  return (req: Request, res: Response, next: NextFunction): void => {
    void middleware(req, res, () => {
      if (res.locals.authorizationRole === 'Repartidor' && permission !== 'read_route_plan') {
        sendErrorEnvelope(res, 403, 'PERMISSION_DENIED', 'Permission is denied')
        return
      }
      next()
    })
  }
}

const authorizeMigrationAdmin = (req: Request, res: Response, next: NextFunction): void => {
  const middleware = checkPermission('route_assignment_index_migration', { currentRole: true })
  void middleware(req, res, () => {
    if (res.locals.authorizationRole !== 'admin') {
      sendErrorEnvelope(res, 403, 'PERMISSION_DENIED', 'Permission is denied')
      return
    }
    next()
  })
}

router.post('/assignment-index/preflight', authenticate, authorizeMigrationAdmin, (req, res) => { void preflightAssignmentIndexMigration(req, res) })
router.post('/assignment-index/apply', authenticate, authorizeMigrationAdmin, (req, res) => { void applyAssignmentIndexMigration(req, res) })
router.get('/dashboard', authenticate, authorize('read_route_plan'), (req, res) => { void getRouteDashboard(req, res) })
router.get('/candidates', authenticate, authorize('create_route_plan'), (req, res) => { void getCandidateItems(req, res) })
router.get('/assignment-options', authenticate, authorize('create_route_plan'), (req, res) => { void getRouteAssignmentOptions(req, res) })
router.post('/preview', authenticate, authorize('create_route_plan'), (req, res) => { void previewRoute(req, res) })
router.post('/', authenticate, authorize('create_route_plan'), (req, res) => { void saveRoutePlan(req, res) })
router.get('/', authenticate, authorize('read_route_plan'), (req, res) => { void getRoutePlans(req, res) })
router.get('/config', authenticate, authorize('read_route_plan'), (req, res) => { void getRouteConfig(req, res) })
router.patch('/config', authenticate, authorize('manage_route_config'), (req, res) => { void patchRouteConfig(req, res) })
router.patch('/:id/operational', authenticate, authorize('create_route_plan'), (req, res) => { void patchRoutePlanOperational(req, res) })
router.get('/:id', authenticate, authorize('read_route_plan'), (req, res) => { void getRoutePlanById(req, res) })

export { router }
