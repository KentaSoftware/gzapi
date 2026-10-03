import { JwtPayload } from 'jsonwebtoken'
import { getLogs } from '../services/log'
import { Request, Response } from 'express'
import { handleHttp } from '../utils/error.handle'

interface RequestExt extends Request {
  user?: string | JwtPayload | undefined | any
}

const getItems = async ({ body }: RequestExt, res: Response): Promise<void> => {
  try {
    const { skip, limit } = body
    const response = await getLogs(parseInt(skip), parseInt(limit))
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_GET_ITEMS')
  }
}

export { getItems }
