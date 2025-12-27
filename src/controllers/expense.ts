import { Request, Response } from 'express'
import { handleHttp } from '../utils/error.handle'
import { JwtPayload } from 'jsonwebtoken'
import ExpenseService from '../services/expense'

interface RequestExt extends Request {
  user?: string | JwtPayload | undefined | any
}

export const createExpense = async ({ body, user }: RequestExt, res: Response): Promise<void> => {
  try {
    const userId = user?.id
    const expense = await ExpenseService.create(body, userId)
    res.status(201).json({ expense })
  } catch (error: any) {
    handleHttp(res, 'ERROR_CREATE_EXPENSE', error)
  }
}

export const listExpenses = async ({ query }: RequestExt, res: Response): Promise<void> => {
  try {
    const result = await ExpenseService.list(query)
    res.json(result)
  } catch (error: any) {
    handleHttp(res, 'ERROR_LIST_EXPENSES', error)
  }
}

export const getExpense = async ({ params }: RequestExt, res: Response): Promise<void> => {
  try {
    const expense = await ExpenseService.getById(params.id)
    if (!expense) {
      res.status(404).json({ error: 'Egreso no encontrado' })
      return
    }
    res.json({ expense })
  } catch (error: any) {
    handleHttp(res, 'ERROR_GET_EXPENSE', error)
  }
}

export const updateExpense = async ({ params, body, user }: RequestExt, res: Response): Promise<void> => {
  try {
    const userId = user?.id
    const expense = await ExpenseService.update(params.id, body, userId)
    if (!expense) {
      res.status(404).json({ error: 'Egreso no encontrado' })
      return
    }
    res.json({ expense })
  } catch (error: any) {
    handleHttp(res, 'ERROR_UPDATE_EXPENSE', error)
  }
}

export const deleteExpense = async ({ params, user }: RequestExt, res: Response): Promise<void> => {
  try {
    const userId = user?.id
    await ExpenseService.softDelete(params.id, userId)
    res.json({ message: 'Egreso eliminado correctamente' })
  } catch (error: any) {
    handleHttp(res, 'ERROR_DELETE_EXPENSE', error)
  }
}
