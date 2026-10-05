import { Request, Response } from 'express'
import { getCandidates, getSnapshot, listSnapshots, preview, RoutePreviewError, saveSnapshot } from '../services/routePlan'
import { candidateQuerySchema, routePreviewRequestSchema } from '../schemas/routeOptimization'
import { handleHttp, sendErrorEnvelope } from '../utils/error.handle'

const getCandidateItems = async (req: Request, res: Response): Promise<void> => {
  const input = candidateQuerySchema.safeParse({
    serviceDate: req.query.serviceDate,
    deliveryZoneId: req.query.deliveryZoneId
  })

  if (!input.success) {
    sendErrorEnvelope(res, 400, 'INVALID_ROUTE_INPUT', 'Route candidate input is invalid')
    return
  }

  try {
    res.send(await getCandidates(input.data))
  } catch (error) {
    handleHttp(res, 'ERROR_GET_ROUTE_CANDIDATES', error)
  }
}

const previewRoute = async (req: Request, res: Response): Promise<void> => {
  const input = routePreviewRequestSchema.safeParse(req.body)
  if (!input.success) {
    sendErrorEnvelope(res, 400, 'INVALID_ROUTE_INPUT', 'Route preview input is invalid')
    return
  }

  try {
    res.send(await preview(input.data))
  } catch (error) {
    if (error instanceof RoutePreviewError) {
      const status = error.code === 'ROUTING_PROVIDER_QUOTA_EXCEEDED'
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
  const input = routePreviewRequestSchema.safeParse(req.body)
  if (!input.success) {
    sendErrorEnvelope(res, 400, 'INVALID_ROUTE_INPUT', 'Route plan input is invalid')
    return
  }

  try {
    res.status(201).send(await saveSnapshot(input.data, res.locals.userId))
  } catch (error) {
    if (error instanceof RoutePreviewError) {
      const status = error.code === 'ROUTING_PROVIDER_QUOTA_EXCEEDED'
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

const getRoutePlans = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.send(await listSnapshots())
  } catch (error) {
    handleHttp(res, 'ERROR_GET_ROUTE_PLANS', error)
  }
}

const getRoutePlanById = async (req: Request, res: Response): Promise<void> => {
  if (!/^[a-fA-F0-9]{24}$/.test(req.params.id)) {
    sendErrorEnvelope(res, 400, 'INVALID_ROUTE_INPUT', 'Route plan identifier is invalid')
    return
  }

  try {
    const routePlan = await getSnapshot(req.params.id)
    if (routePlan === null) {
      sendErrorEnvelope(res, 404, 'ROUTE_PLAN_NOT_FOUND', 'Route plan was not found')
      return
    }
    res.send(routePlan)
  } catch (error) {
    handleHttp(res, 'ERROR_GET_ROUTE_PLAN', error)
  }
}

export { getCandidateItems, previewRoute, saveRoutePlan, getRoutePlans, getRoutePlanById }
