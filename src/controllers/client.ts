import { Request, Response } from 'express'
import { handleHttp, sendErrorEnvelope } from '../utils/error.handle'
import { Types } from 'mongoose'
import { JwtPayload } from 'jsonwebtoken'
import { emitSocket } from '../socket'
import {
  ClientNotFoundError,
  confirmLocation,
  geocodeClient,
  getClient,
  getClients,
  getClientSearch,
  getSaleClientOptions,
  getSaleClientOptionsPage,
  insertClient,
  updateClient
} from '../services/client'
import { GeocodingProviderUnavailableError } from '../services/geocodingProvider'
import { clientLocationConfirmationSchema, geocodeRequestSchema } from '../schemas/clientGeocoding'

interface RequestExt extends Request {
  user?: string | JwtPayload | undefined | any
}

const getItem = async ({ params }: RequestExt, res: Response): Promise<void> => {
  try {
    const { id } = params
    const response = await getClient(new Types.ObjectId(id))
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_GET_CLIENT_BY_ID', e)
  }
}
const getItems = async ({ body }: RequestExt, res: Response): Promise<void> => {
  try {
    const { input, skip, limit } = body
    if (input !== undefined) {
      const response = await getClientSearch(input)
      res.send(response)
      return
    }
    const response = await getClients(parseInt(skip), parseInt(limit))
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_GET_CLIENTS_LIST', e)
  }
}
const uptdateItem = async ({ params, body }: Request, res: Response): Promise<void> => {
  try {
    const { id } = params
    const response = await updateClient(new Types.ObjectId(id), body)
    emitSocket('client', {
      action: 'update',
      data: body
    })
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_UPDATE_CLIENT', e)
  }
}
const postItem = async ({ body }: Request, res: Response): Promise<void> => {
  try {
    const response = await insertClient(body)
    emitSocket('client', {
      action: 'create',
      data: response
    })
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_CREATE_CLIENT', e)
  }
}
const deleteItem = (_: Request, res: Response): void => {
  try {
    res.send({ data: 'algo' })
  } catch (e) {
    handleHttp(res, 'ERROR_DELETE_CLIENT', e)
  }
}

const getSaleOptions = async (req: Request, res: Response): Promise<void> => {
  const input = req.query.q
  if (input !== undefined && (typeof input !== 'string' || input.length > 100)) {
    sendErrorEnvelope(res, 400, 'INVALID_CLIENT_SEARCH', 'Client search must be a string of at most 100 characters')
    return
  }
  const query = (input ?? '').trim()
  const { paged, limit, cursor } = req.query
  if ((paged !== undefined && paged !== 'true') || (cursor !== undefined && paged !== 'true')) {
    sendErrorEnvelope(res, 400, 'INVALID_CLIENT_PAGING', 'Client paging parameters are invalid')
    return
  }
  if (paged === 'true') {
    if ((limit !== undefined && (typeof limit !== 'string' || !/^[1-9]\d*$/.test(limit) || Number(limit) > 100)) ||
      (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)))) {
      sendErrorEnvelope(res, 400, 'INVALID_CLIENT_PAGING', 'Client paging parameters are invalid')
      return
    }
    let decoded: { id: string, query: string } | undefined
    if (typeof cursor === 'string') {
      try {
        const bytes = Buffer.from(cursor, 'base64url')
        const value: unknown = JSON.parse(bytes.toString('utf8'))
        if (bytes.toString('base64url') !== cursor || typeof value !== 'object' || value === null || Array.isArray(value) ||
          !('id' in value) || typeof value.id !== 'string' || !/^[a-f0-9]{24}$/.test(value.id) ||
          !('query' in value) || value.query !== query || Object.keys(value).length !== 2) throw new Error('Invalid cursor')
        decoded = { id: value.id, query }
      } catch {
        sendErrorEnvelope(res, 400, 'INVALID_CLIENT_PAGING', 'Client paging parameters are invalid')
        return
      }
    }
    try {
      res.send(await getSaleClientOptionsPage(query, limit === undefined ? 20 : Number(limit), decoded))
    } catch {
      sendErrorEnvelope(res, 500, 'CLIENT_SEARCH_UNAVAILABLE', 'Client search is unavailable')
    }
    return
  }
  if (query.length < 2) {
    res.send({ clients: [] })
    return
  }
  try {
    res.send({ clients: await getSaleClientOptions(query) })
  } catch {
    sendErrorEnvelope(res, 500, 'CLIENT_SEARCH_UNAVAILABLE', 'Client search is unavailable')
  }
}

const clientObjectId = (id: string): Types.ObjectId | undefined => {
  if (!Types.ObjectId.isValid(id)) return undefined
  return new Types.ObjectId(id)
}

const geocodeItem = async ({ params, body }: RequestExt, res: Response): Promise<void> => {
  const id = clientObjectId(params.id)
  const request = geocodeRequestSchema.safeParse(body)
  if (id === undefined || !request.success) {
    sendErrorEnvelope(res, 400, 'INVALID_LOCATION_INPUT', 'Location input is invalid')
    return
  }

  try {
    const candidates = await geocodeClient(id, request.data.address)
    res.send({ candidates })
  } catch (error: unknown) {
    if (error instanceof ClientNotFoundError) {
      sendErrorEnvelope(res, 404, 'CLIENT_NOT_FOUND', 'Client was not found')
      return
    }
    if (error instanceof GeocodingProviderUnavailableError) {
      sendErrorEnvelope(res, 503, 'GEOCODING_PROVIDER_UNAVAILABLE', 'Geocoding provider is unavailable')
      return
    }
    if (error instanceof Error && error.message === 'Client address is required') {
      sendErrorEnvelope(res, 400, 'INVALID_LOCATION_INPUT', 'Client address is required')
      return
    }
    handleHttp(res, 'ERROR_GEOCODE_CLIENT', error)
  }
}

const confirmLocationItem = async ({ params, body }: RequestExt, res: Response): Promise<void> => {
  const id = clientObjectId(params.id)
  const confirmation = clientLocationConfirmationSchema.safeParse(body)
  const userId = res.locals.userId
  if (id === undefined || !confirmation.success || typeof userId !== 'string' || !Types.ObjectId.isValid(userId)) {
    sendErrorEnvelope(res, 400, 'INVALID_LOCATION_INPUT', 'Location input is invalid')
    return
  }

  try {
    const client = await confirmLocation(id, confirmation.data, userId)
    emitSocket('client', { action: 'update', data: client })
    res.send(client)
  } catch (error: unknown) {
    if (error instanceof ClientNotFoundError) {
      sendErrorEnvelope(res, 404, 'CLIENT_NOT_FOUND', 'Client was not found')
      return
    }
    handleHttp(res, 'ERROR_CONFIRM_CLIENT_LOCATION', error)
  }
}

export { confirmLocationItem, deleteItem, geocodeItem, getItem, getItems, getSaleOptions, uptdateItem, postItem }
