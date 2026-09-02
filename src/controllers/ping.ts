import { Request, Response } from "express"
import { JwtPayload } from "jsonwebtoken"
import { handleHttp } from "../utils/error.handle"

interface RequestExt extends Request {
  user?: string | JwtPayload | undefined | any
}

const getItem = async (_: RequestExt, res: Response): Promise<void> => {
    try {
      res.send('PING')
    } catch (e) {
      handleHttp(res, 'ERROR_GET_ITEM')
    }
}

export { getItem }