import { Request, Response } from 'express'
import { Types } from 'mongoose'
import { JwtPayload } from 'jsonwebtoken'
import { emitSocket } from '../socket'
import { getUser, getUsers, updateUser, deleteUser, getUserSearch, qtyUsers, getAllUsers } from '../services/user'
import { handleHttp } from '../utils/error.handle'

interface RequestExt extends Request {
  user?: string | JwtPayload | undefined | any
}

const getAllItems = async (_: RequestExt, res: Response): Promise<void> => {
  try {
    const response = await getAllUsers()
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_GET_USERS_LIST', e)
  }
}

const getItem = async ({ params }: RequestExt, res: Response): Promise<void> => {
  try {
    const { id } = params
    const response = await getUser(new Types.ObjectId(id))
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_GET_USER_BY_ID', e)
  }
}

const getItems = async ({ body }: RequestExt, res: Response): Promise<void> => {
  try {
    const { input, skip, limit } = body
    if (input !== undefined && skip === undefined && limit === undefined) {
      const response = await getUserSearch(input)
      res.send(response)
    } else {
      const response = await getUsers(parseInt(skip), parseInt(limit))
      const cantidad = await qtyUsers()
      res.send({ array: response, longitud: cantidad })
    }
  } catch (e) {
    handleHttp(res, 'ERROR_GET_USERS_LIST', e)
  }
}

const updateItem = async ({ params, body, user }: RequestExt, res: Response): Promise<void> => {
  try {
    const { id } = params
    const response = await updateUser(new Types.ObjectId(id), body, { userId: user?.id })
    emitSocket('user', {
      action: 'update',
      data: response
    })
    res.send(response)
  } catch (e) {
    console.log('error', e)
    handleHttp(res, 'ERROR_UPDATE_USER', e)
  }
}

const deleteItem = async ({ params }: Request, res: Response): Promise<void> => {
  try {
    const { id } = params
    const response = await deleteUser(new Types.ObjectId(id))
    emitSocket('user', {
      action: 'delete',
      data: id
    })
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_DELETE_USER', e)
  }
}

export { getItem, getItems, updateItem, deleteItem, getAllItems } 