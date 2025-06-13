import { Request, Response } from 'express'
import { Types } from 'mongoose'
import { JwtPayload } from 'jsonwebtoken'
import { emitSocket } from '../socket'
import { getRole, getRoles, getRolesAll, updateRole, deleteRole, getRoleSearch, qtyRoles, insertRole } from '../services/role.'
import { handleHttp } from '../utils/error.handle'

interface RequestExt extends Request {
  user?: string | JwtPayload | undefined | any
}

const createItem = async ({ body }: RequestExt, res: Response): Promise<void> => {
  try {
    const response = await insertRole(body)
    emitSocket('role', {
      action: 'create',
      data: body
    })
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_CREATE_ITEM')
  }
}
const getItem = async ({ params }: RequestExt, res: Response): Promise<void> => {
  try {
    const { id } = params
    console.log("id", id)
    const response = await getRole(new Types.ObjectId(id))
    console.log("response", response)
    if (!response) {
      res.status(404).send({ error: 'Role not found' })
      return
    }
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_GET_ITEM')
  }
}

const getItems = async ({ body }: RequestExt, res: Response): Promise<void> => {
  try {
    const { input, skip, limit } = body

    if (input !== undefined) {
      const response = await getRoleSearch(input)
      res.send(response)
      return
    }

    if (skip === undefined && limit === undefined) {
      const response = await getRolesAll()
      res.send(response)
      return
    }

    const response = await getRoles(parseInt(skip), parseInt(limit))
    const cantidad = await qtyRoles()
    res.send({ array: response, longitud: cantidad })
  } catch (e) {
    handleHttp(res, 'ERROR_GET_ITEMS')
  }
}

const updateItem = async ({ params, body }: Request, res: Response): Promise<void> => {
  try {
    const { id } = params
    const response = await updateRole(new Types.ObjectId(id), body)
    if (!response) {
      res.status(404).send({ error: 'Role not found' })
      return
    }
    emitSocket('role', {
      action: 'update',
      data: response
    })
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_UPDATE_ITEM')
  }
}

const deleteItem = async ({ params }: Request, res: Response): Promise<void> => {
  try {
    const { id } = params
    const response = await deleteRole(new Types.ObjectId(id))
    if (!response) {
      res.status(404).send({ error: 'Role not found' })
      return
    }
    emitSocket('role', {
      action: 'delete',
      data: id
    })
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_DELETE_ITEM')
  }
}

export { getItem, getItems, updateItem, deleteItem, createItem } 