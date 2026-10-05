import { Request, Response } from 'express'
import { getCandidates, preview, RoutePreviewError } from '../services/routePlan'
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

export { getCandidateItems, previewRoute }
