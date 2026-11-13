import { Request, Response } from 'express'
import { getAssignmentOptions, getCandidates, getRoutingConfig, getSnapshot, listSnapshots, logRoutePlanEvent, preview, RoutePreviewError, saveLegacySnapshot, saveSnapshot, updateRoutingConfig } from '../services/routePlan'
import { candidateQuerySchema, dashboardQuerySchema, legacyRouteSaveRequestSchema, routeOperationalUpdateSchema, routePreviewRequestSchema, routeSaveRequestSchema, routingConfigUpdateSchema } from '../schemas/routeOptimization'
import { handleHttp, sendErrorEnvelope } from '../utils/error.handle'
import { getDashboard } from '../services/routeDashboard'
import { assign, createProjection, OperationalProjectionError } from '../services/routePlanOperational'
import { AssignmentConflictError, AssignmentSafetyError } from '../services/routeAssignment'
import type { RouteOperationalStatus } from '../interfaces/routeOptimization.interface'
const handleAssignmentError = (res: Response, error: unknown): boolean => {
  if (error instanceof AssignmentConflictError) { sendErrorEnvelope(res, 409, 'ROUTE_SALE_ALREADY_ASSIGNED', error.message); return true }
  if (error instanceof AssignmentSafetyError) { sendErrorEnvelope(res, 503, 'ROUTE_ASSIGNMENT_UNAVAILABLE', 'Route assignment safety verification is unavailable'); return true }
  return false
}

const driverScope = (res: Response): string | undefined => {
  return res.locals.authorizationRole === 'Repartidor' ? String(res.locals.userId ?? '') : undefined
}

const logRouteControllerEvent = (operation: string, res: Response, startedAt: number, outcome: string, routeSnapshotId?: string): void => {
  console.log(JSON.stringify({
    event: 'route_operation_observed',
    operation,
    outcome,
    correlationId: res.locals.correlationId,
    latencyMs: Date.now() - startedAt,
    actor: res.locals.userId,
    routeSnapshotId
  }))
}

const getRouteDashboard = async (req: Request, res: Response): Promise<void> => {
  const input = dashboardQuerySchema.safeParse({
    serviceDate: req.query.serviceDate,
    zoneCode: req.query.zoneCode,
    status: req.query.status
  })
  if (!input.success) {
    logRoutePlanEvent({ event: 'route_plan_snapshot_read_failed', correlationId: res.locals.correlationId, latencyMs: 0, resultCode: 'INVALID_ROUTE_INPUT' })
    sendErrorEnvelope(res, 400, 'INVALID_ROUTE_INPUT', 'Route dashboard input is invalid')
    return
  }
  try {
    res.send(await getDashboard({ ...input.data, status: input.data.status as RouteOperationalStatus | undefined }, { correlationId: res.locals.correlationId, actor: res.locals.userId, driverId: driverScope(res) }))
  } catch (error) {
    if (handleAssignmentError(res, error)) return
    handleHttp(res, 'ERROR_GET_ROUTE_DASHBOARD', error)
  }
}

const getCandidateItems = async (req: Request, res: Response): Promise<void> => {
  const input = candidateQuerySchema.safeParse({
    serviceDate: req.query.serviceDate,
    deliveryZoneId: req.query.deliveryZoneId
  })

  if (!input.success) {
    logRoutePlanEvent({ event: 'route_plan_candidates_read_failed', correlationId: res.locals.correlationId, latencyMs: 0, resultCode: 'INVALID_ROUTE_INPUT' })
    sendErrorEnvelope(res, 400, 'INVALID_ROUTE_INPUT', 'Route candidate input is invalid')
    return
  }

  try {
    res.send(await getCandidates(input.data, { correlationId: res.locals.correlationId }))
  } catch (error) {
    if (handleAssignmentError(res, error)) return
    handleHttp(res, 'ERROR_GET_ROUTE_CANDIDATES', error)
  }
}

const getRouteAssignmentOptions = async (_req: Request, res: Response): Promise<void> => {
  const startedAt = Date.now()
  try {
    res.send(await getAssignmentOptions())
    logRouteControllerEvent('assignment-options.read', res, startedAt, 'SUCCESS')
  } catch (error) {
    logRouteControllerEvent('assignment-options.read', res, startedAt, 'INTERNAL_ERROR')
    handleHttp(res, 'ERROR_GET_ROUTE_ASSIGNMENT_OPTIONS', error)
  }
}

const previewRoute = async (req: Request, res: Response): Promise<void> => {
  const input = routePreviewRequestSchema.safeParse(req.body)
  if (!input.success) {
    logRoutePlanEvent({ event: 'route_plan_preview_failed', correlationId: res.locals.correlationId, latencyMs: 0, resultCode: 'INVALID_ROUTE_INPUT' })
    const assignmentIssues = input.error.issues.filter((issue) => issue.path[0] === 'driverId' || issue.path[0] === 'vehicleId')
    if (assignmentIssues.length > 0) {
      sendErrorEnvelope(res, 422, 'ROUTE_ASSIGNMENT_REQUIRED', assignmentIssues.map((issue) => issue.message).join('; '))
    } else {
      sendErrorEnvelope(res, 400, 'INVALID_ROUTE_INPUT', 'Route preview input is invalid')
    }
    return
  }

  try {
    res.send(await preview(input.data, { correlationId: res.locals.correlationId, actor: res.locals.userId }))
  } catch (error) {
    if (handleAssignmentError(res, error)) return
    if (error instanceof RoutePreviewError) {
      const status = error.code === 'PREVIEW_RECEIPT_CONFLICT'
        ? 409
        : error.code === 'ROUTING_PROVIDER_QUOTA_EXCEEDED'
          ? 429
          : error.code === 'ROUTING_PROVIDER_UNAVAILABLE'
            ? 503
            : error.code === 'INVALID_ROUTE_INPUT'
              ? 400
              : 422
      sendErrorEnvelope(res, status, error.code, error.message)
      return
    }
    handleHttp(res, 'ERROR_PREVIEW_ROUTE_PLAN', error)
  }
}

const saveRoutePlan = async (req: Request, res: Response): Promise<void> => {
  const input = routeSaveRequestSchema.safeParse(req.body)
  if (!input.success) {
    logRoutePlanEvent({ event: 'route_plan_snapshot_save_failed', correlationId: res.locals.correlationId, latencyMs: 0, resultCode: 'INVALID_ROUTE_INPUT' })
    const legacy = legacyRouteSaveRequestSchema.safeParse(req.body)
    const issues = legacy.success ? [] : legacy.error.issues
    const assignmentIssues = issues.filter((issue) => issue.path[0] === 'driverId' || issue.path[0] === 'vehicleId')
    if (assignmentIssues.length > 0 && !issues.some((issue) => issue.code === 'unrecognized_keys')) {
      sendErrorEnvelope(res, 422, 'ROUTE_ASSIGNMENT_REQUIRED', assignmentIssues.map((issue) => issue.message).join('; '))
    } else {
      sendErrorEnvelope(res, 400, 'INVALID_ROUTE_INPUT', 'Route plan input is invalid')
    }
    return
  }

  try {
    const context = { correlationId: res.locals.correlationId }
    const saved = 'receipt' in input.data
      ? await saveSnapshot(input.data, res.locals.userId, context)
      : await saveLegacySnapshot(input.data, res.locals.userId, context)
    res.status(201).send(saved)
  } catch (error) {
    if (handleAssignmentError(res, error)) return
    if (error instanceof RoutePreviewError) {
      const status = error.code === 'PREVIEW_RECEIPT_CONFLICT'
        ? 409
        : error.code === 'ROUTING_PROVIDER_QUOTA_EXCEEDED'
          ? 429
          : error.code === 'ROUTING_PROVIDER_UNAVAILABLE'
            ? 503
            : error.code === 'INVALID_ROUTE_INPUT'
              ? 400
              : 422
      sendErrorEnvelope(res, status, error.code, error.message)
      return
    }
    handleHttp(res, 'ERROR_SAVE_ROUTE_PLAN', error)
  }
}

const getRouteConfig = async (_req: Request, res: Response): Promise<void> => {
  try {
    const config = await getRoutingConfig({ correlationId: res.locals.correlationId })
    if (config === null) {
      sendErrorEnvelope(res, 404, 'INVALID_CONFIGURATION', 'Routing configuration is not available')
      return
    }
    res.send(config)
  } catch (error) {
    handleHttp(res, 'ERROR_GET_ROUTE_CONFIG', error)
  }
}

const patchRouteConfig = async (req: Request, res: Response): Promise<void> => {
  const input = routingConfigUpdateSchema.safeParse(req.body)
  if (!input.success) {
    logRoutePlanEvent({ event: 'route_plan_config_update_failed', correlationId: res.locals.correlationId, latencyMs: 0, resultCode: 'INVALID_CONFIGURATION' })
    sendErrorEnvelope(res, 400, 'INVALID_CONFIGURATION', 'Routing configuration input is invalid')
    return
  }

  try {
    res.send(await updateRoutingConfig(input.data, res.locals.userId, { correlationId: res.locals.correlationId }))
  } catch (error) {
    handleHttp(res, 'ERROR_UPDATE_ROUTE_CONFIG', error)
  }
}

const getRoutePlans = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.send(await listSnapshots({ correlationId: res.locals.correlationId, driverId: driverScope(res) }))
  } catch (error) {
    handleHttp(res, 'ERROR_GET_ROUTE_PLANS', error)
  }
}

const getRoutePlanById = async (req: Request, res: Response): Promise<void> => {
  if (!/^[a-fA-F0-9]{24}$/.test(req.params.id)) {
    logRoutePlanEvent({ event: 'route_plan_snapshot_read_failed', correlationId: res.locals.correlationId, latencyMs: 0, resultCode: 'INVALID_ROUTE_INPUT' })
    sendErrorEnvelope(res, 400, 'INVALID_ROUTE_INPUT', 'Route plan identifier is invalid')
    return
  }

  try {
    const routePlan = await getSnapshot(req.params.id, { correlationId: res.locals.correlationId, driverId: driverScope(res) })
    if (routePlan === null) {
      sendErrorEnvelope(res, 404, 'ROUTE_PLAN_NOT_FOUND', 'Route plan was not found')
      return
    }
    res.send(routePlan)
  } catch (error) {
    handleHttp(res, 'ERROR_GET_ROUTE_PLAN', error)
  }
}

const patchRoutePlanOperational = async (req: Request, res: Response): Promise<void> => {
  const startedAt = Date.now()
  if (!/^[a-fA-F0-9]{24}$/.test(req.params.id)) {
    sendErrorEnvelope(res, 400, 'INVALID_ROUTE_INPUT', 'Route plan identifier is invalid')
    return
  }
  const input = routeOperationalUpdateSchema.safeParse(req.body)
  if (!input.success) {
    sendErrorEnvelope(res, 400, 'INVALID_ROUTE_INPUT', 'Operational update accepts only version, driverId and vehicleId')
    return
  }
  try {
    await createProjection(req.params.id, { changedBy: res.locals.userId })
    const result = await assign(req.params.id, { ...input.data, changedBy: res.locals.userId, correlationId: res.locals.correlationId })
    res.send(result)
    logRouteControllerEvent('operational.update', res, startedAt, 'SUCCESS', req.params.id)
  } catch (error) {
    if (error instanceof OperationalProjectionError) {
      const status = error.code === 'ROUTE_OPERATIONAL_VERSION_CONFLICT' ? 409 : error.code === 'ROUTE_OPERATIONAL_NOT_FOUND' ? 404 : 422
      sendErrorEnvelope(res, status, error.code, error.message)
      logRouteControllerEvent('operational.update', res, startedAt, error.code)
      return
    }
    logRouteControllerEvent('operational.update', res, startedAt, 'INTERNAL_ERROR', req.params.id)
    handleHttp(res, 'ERROR_UPDATE_ROUTE_OPERATIONAL', error)
  }
}

export { getCandidateItems, getRouteAssignmentOptions, previewRoute, saveRoutePlan, getRouteConfig, patchRouteConfig, getRoutePlans, getRoutePlanById, getRouteDashboard, patchRoutePlanOperational }
