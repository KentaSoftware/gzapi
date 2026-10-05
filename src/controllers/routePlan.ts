import { Request, Response } from 'express'
import { getCandidates } from '../services/routePlan'
import { candidateQuerySchema } from '../schemas/routeOptimization'
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

export { getCandidateItems }
