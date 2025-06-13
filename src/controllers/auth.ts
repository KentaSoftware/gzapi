import { Request, Response } from 'express'
import { loginUser, registerNewUser } from '../services/auth'
import { emitSocket } from '../socket'

const registerCtrl = async ({ body }: Request, res: Response): Promise<void> => {
  const responseUser = await registerNewUser(body)
  emitSocket('user', {
    action: 'create',
    data: responseUser
  })
  res.send(responseUser)
}

const loginCtrl = async ({ body }: Request, res: Response): Promise<void> => {
  const responseUser = await loginUser(body)
  res.send(responseUser)
}

export { loginCtrl, registerCtrl }
