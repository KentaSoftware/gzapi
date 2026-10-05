import { Request, Response } from 'express'
import { createDeliveryZone, DeliveryZoneError, listDeliveryZones, updateDeliveryZone } from '../services/deliveryZone'
import { deliveryZoneCreateSchema, deliveryZoneQuerySchema, deliveryZoneUpdateSchema } from '../schemas/routeOptimization'
import { DELIVERY_ZONE_ERROR_CODES } from '../interfaces/routeOptimization.interface'
import { handleHttp, sendErrorEnvelope } from '../utils/error.handle'

const OBJECT_ID_PATTERN = /^[a-fA-F0-9]{24}$/

const sendDeliveryZoneError = (res: Response, error: unknown): boolean => {
  if (!(error instanceof DeliveryZoneError)) return false
  const status = error.code === DELIVERY_ZONE_ERROR_CODES.DELIVERY_ZONE_NOT_FOUND ? 404 : 409
  sendErrorEnvelope(res, status, error.code, error.message)
  return true
}

const getItems = async (req: Request, res: Response): Promise<void> => {
  const query = deliveryZoneQuerySchema.safeParse({ active: req.query.active })
  if (!query.success) {
    sendErrorEnvelope(res, 400, 'INVALID_ROUTE_INPUT', 'Delivery zone query is invalid')
    return
  }

  const filter = query.data.active === undefined ? {} : { active: query.data.active === 'true' }
  try {
    res.send(await listDeliveryZones(filter))
  } catch (error) {
    handleHttp(res, 'ERROR_GET_DELIVERY_ZONES', error)
  }
}

const postItem = async (req: Request, res: Response): Promise<void> => {
  const input = deliveryZoneCreateSchema.safeParse(req.body)
  if (!input.success) {
    sendErrorEnvelope(res, 400, 'INVALID_ROUTE_INPUT', 'Delivery zone input is invalid')
    return
  }

  try {
    res.status(201).send(await createDeliveryZone(input.data))
  } catch (error) {
    if (!sendDeliveryZoneError(res, error)) handleHttp(res, 'ERROR_CREATE_DELIVERY_ZONE', error)
  }
}

const patchItem = async (req: Request, res: Response): Promise<void> => {
  if (!OBJECT_ID_PATTERN.test(req.params.id)) {
    sendErrorEnvelope(res, 400, 'INVALID_ROUTE_INPUT', 'Delivery zone identifier is invalid')
    return
  }

  const input = deliveryZoneUpdateSchema.safeParse(req.body)
  if (!input.success) {
    sendErrorEnvelope(res, 400, 'INVALID_ROUTE_INPUT', 'Delivery zone input is invalid')
    return
  }

  try {
    res.send(await updateDeliveryZone(req.params.id, input.data))
  } catch (error) {
    if (!sendDeliveryZoneError(res, error)) handleHttp(res, 'ERROR_UPDATE_DELIVERY_ZONE', error)
  }
}

export { getItems, postItem, patchItem }
