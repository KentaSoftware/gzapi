import { Request, Response } from 'express'
import { handleHttp } from '../utils/error.handle'
import { Types } from 'mongoose'
import { JwtPayload } from 'jsonwebtoken'
import { emitSocket } from '../socket'
import { getClient, getClients, getClientSearch, insertClient, updateClient } from '../services/client'

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

export { getItem, getItems, uptdateItem, postItem, deleteItem }
