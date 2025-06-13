import { Request, Response } from 'express'
import { Types } from 'mongoose'
import { JwtPayload } from 'jsonwebtoken'
import { emitSocket } from '../socket'
import { getUser, getUsers, updateUser, deleteUser, getUserSearch, qtyUsers } from '../services/user'
import { handleHttp } from '../utils/error.handle'

interface RequestExt extends Request {
  user?: string | JwtPayload | undefined | any
}

const getItem = async ({ params }: RequestExt, res: Response): Promise<void> => {
  try {
    const { id } = params
    const response = await getUser(new Types.ObjectId(id))
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_GET_ITEM')
  }
}

const getItems = async ({ body }: RequestExt, res: Response): Promise<void> => {
  try {
    const { input, skip, limit } = body
    console.log('input', input, skip, limit)
    if (input !== undefined && skip === undefined && limit === undefined) {
      const response = await getUserSearch(input)
      res.send(response)
    } else {
      const response = await getUsers(parseInt(skip), parseInt(limit))
      const cantidad = await qtyUsers()
      res.send({ array: response, longitud: cantidad })
    }
  } catch (e) {
    handleHttp(res, 'ERROR_GET_ITEMS')
  }
}

const updateItem = async ({ params, body }: Request, res: Response): Promise<void> => {
  try {
    const { id } = params
    const response = await updateUser(new Types.ObjectId(id), body)
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_UPDATE_ITEM')
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
    handleHttp(res, 'ERROR_DELETE_ITEM')
  }
}

export { getItem, getItems, updateItem, deleteItem } 