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

export const listExpenses = async ({ query, user }: RequestExt, res: Response): Promise<void> => {
  try {
    const userId = user?.id
    const result = await ExpenseService.list(query)
    
    // Emitir evento BI expense_list_viewed
    const { emitSocket } = require('../socket')
    emitSocket('expense', {
      action: 'list_viewed',
      data: {
        event: 'expense_list_viewed',
        timestamp: new Date().toISOString(),
        user: {
          id: userId,
          email: user?.email,
          name: user?.name
        },
        filters: {
          rango_fechas: {
            from: result._metadata.effectiveFrom,
            to: result._metadata.effectiveTo,
            default_applied: result._metadata.defaultApplied
          },
          type: result._metadata.appliedFilters.type,
          category: result._metadata.appliedFilters.category,
          paymentMethod: result._metadata.appliedFilters.paymentMethod,
          search: result._metadata.appliedFilters.search
        },
        pagination: {
          page: result.pagination.page,
          limit: result.pagination.limit
        },
        results: {
          totalItems: result.pagination.total,
          returnedItems: result.expenses.length
        }
      }
    })
    
    // Agregar flags de permisos a la respuesta
    const userPermissions = user?.permissions || []
    const canEdit = userPermissions.includes('update_expense')
    const canDelete = userPermissions.includes('delete_expense')
    
    // Remover metadata interna antes de enviar response
    const { _metadata, ...responseData } = result
    
    res.json({
      ...responseData,
      permissions: {
        canEdit,
        canDelete
      }
    })
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
    res.json({ expense })
  } catch (error: any) {
    // Manejar status codes específicos
    if (error.status === 404) {
      res.status(404).json({ error: error.message })
      return
    }
    if (error.status === 410) {
      res.status(410).json({ error: error.message })
      return
    }
    if (error.status === 400) {
      res.status(400).json({ error: error.message })
      return
    }
    handleHttp(res, 'ERROR_UPDATE_EXPENSE', error)
  }
}

export const deleteExpense = async ({ params, user }: RequestExt, res: Response): Promise<void> => {
  try {
    const userId = user?.id
    const expense = await ExpenseService.softDelete(params.id, userId)
    res.json({ 
      message: 'Egreso eliminado correctamente',
      expense 
    })
  } catch (error: any) {
    // Manejar status codes específicos
    if (error.status === 404) {
      res.status(404).json({ error: error.message })
      return
    }
    if (error.status === 400) {
      res.status(400).json({ error: error.message })
      return
    }
    handleHttp(res, 'ERROR_DELETE_EXPENSE', error)
  }
}
