import { Request, Response } from 'express'
import { handleHttp } from '../utils/error.handle'
import { Types } from 'mongoose'
import { JwtPayload } from 'jsonwebtoken'
import { emitSocket } from '../socket'
import { getProvider, getProviders, insertProvider, updateProvider } from '../services/provider'

interface RequestExt extends Request {
  user?: string | JwtPayload | undefined | any
}

const getItem = async ({ params }: RequestExt, res: Response): Promise<void> => {
  try {
    const { id } = params
    const response = await getProvider(new Types.ObjectId(id))
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_GET_PROVIDER_BY_ID', e)
  }
}
const getItems = async (_: RequestExt, res: Response): Promise<void> => {
  try {
    const response = await getProviders()
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_GET_PROVIDERS_LIST', e)
  }
}
const uptdateItem = async ({ params, body }: Request, res: Response): Promise<void> => {
  try {
    const { id } = params
    const response = await updateProvider(new Types.ObjectId(id), body)
    emitSocket('provider', {
      action: 'update',
      data: body
    })
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_UPDATE_PROVIDER', e)
  }
}
const postItem = async ({ body }: Request, res: Response): Promise<void> => {
  try {
    const response = await insertProvider(body)
    emitSocket('provider', {
      action: 'create',
      data: response
    })
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_CREATE_PROVIDER', e)
  }
}
const deleteItem = (_: Request, res: Response): void => {
  try {
    res.send({ data: 'algo' })
  } catch (e) {
    handleHttp(res, 'ERROR_DELETE_PROVIDER', e)
  }
}

export { getItem, getItems, uptdateItem, postItem, deleteItem }
