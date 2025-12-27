import { Request, Response } from 'express'
import { handleHttp } from '../utils/error.handle'
import { JwtPayload } from 'jsonwebtoken'
import ExpenseService from '../services/expense'
import { emitSocket } from '../socket'

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
            tipo_filtro: result._metadata.tipo_filtro,
            preset: result._metadata.preset
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
    
    // Emitir evento BI expense_search_used SI search presente
    if (result._metadata.appliedFilters.search) {
      const searchTerm = result._metadata.appliedFilters.search
      emitSocket('expense', {
        action: 'search_used',
        data: {
          event: 'expense_search_used',
          timestamp: new Date().toISOString(),
          user: {
            id: userId,
            email: user?.email,
            name: user?.name
          },
          search: {
            término: searchTerm,
            longitud: searchTerm.length,
            hay_resultados: result.pagination.total > 0,
            total_resultados: result.pagination.total
          },
          filtros_adicionales: {
            from: result._metadata.effectiveFrom,
            to: result._metadata.effectiveTo,
            tipo_filtro: result._metadata.tipo_filtro,
            preset: result._metadata.preset,
            type: result._metadata.appliedFilters.type,
            category: result._metadata.appliedFilters.category,
            paymentMethod: result._metadata.appliedFilters.paymentMethod
          },
          pagination: {
            page: result.pagination.page,
            limit: result.pagination.limit
          }
        }
      })
    }
    
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
    // Manejar errores de validación con código 400
    if (error.message?.includes('formato inválido') || 
        error.message?.includes('no puede ser posterior') ||
        error.message?.includes('Preset inválido') ||
        error.message?.includes('Límite máximo') ||
        error.message?.includes('término de búsqueda') ||
        error.message?.includes('inválido')) {
      res.status(400).json({ error: error.message })
      return
    }
    handleHttp(res, 'ERROR_LIST_EXPENSES', error)
  }
}

export const getExpense = async ({ params, user }: RequestExt, res: Response): Promise<void> => {
  try {
    // GAP-01: Validar ObjectId antes de query
    const { Types } = require('mongoose')
    if (!Types.ObjectId.isValid(params.id)) {
      res.status(400).json({ error: 'ID de egreso inválido' })
      return
    }

    const expense = await ExpenseService.getById(params.id)
    
    if (!expense) {
      // GAP-02: Verificar si está eliminado (soft delete) para retornar 410
      const ExpenseModel = require('../models/expense').default
      const deleted = await ExpenseModel.findOne({ _id: params.id, isDeleted: true })
      
      if (deleted) {
        res.status(410).json({ 
          error: 'Egreso eliminado',
          deletedAt: deleted.deletedAt 
        })
        return
      }
      
      res.status(404).json({ error: 'Egreso no encontrado' })
      return
    }

    // GAP-03: Emitir evento BI expense_detail_viewed (solo en éxito)
    const { emitSocket } = require('../socket')
    emitSocket('expense', {
      action: 'detail_viewed',
      data: {
        event: 'expense_detail_viewed',
        timestamp: new Date().toISOString(),
        user: {
          id: user?.id,
          email: user?.email,
          name: user?.name
        },
        expense: {
          id: expense._id,
          type: expense.type,
          category: expense.category,
          paymentMethod: expense.paymentMethod,
          amountCents: expense.amountCents,
          date: expense.date
        }
      }
    })

    // GAP-04: Calcular flags de permisos
    const userPermissions = user?.permissions || []
    const canEdit = userPermissions.includes('update_expense')
    const canDelete = userPermissions.includes('delete_expense')

    res.json({ 
      expense,
      permissions: {
        canEdit,
        canDelete
      }
    })
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

export const getExpensesKPI = async ({ query, user }: RequestExt, res: Response): Promise<void> => {
  try {
    const result = await ExpenseService.getExpensesTotal(query)

    // Emitir evento BI dashboard_expense_kpi_viewed
    emitSocket('dashboard', {
      action: 'kpi_viewed',
      data: {
        event: 'dashboard_expense_kpi_viewed',
        timestamp: new Date().toISOString(),
        user: {
          id: user?.id,
          email: user?.email,
          name: user?.name
        },
        period: {
          from: query.from,
          to: query.to
        },
        filter: {
          tipo_egreso: query.type || null
        },
        result: {
          totalAmount: result.totalAmount,
          totalCents: result.totalCents,
          currency: result.currency
        }
      }
    })

    res.status(200).json(result)
  } catch (error: any) {
    // Validaciones retornan 400
    if (
      error.message.includes('requeridos') ||
      error.message.includes('Formato inválido') ||
      error.message.includes('no puede ser posterior') ||
      error.message.includes('inválido')
    ) {
      res.status(400).json({ error: error.message })
      return
    }
    handleHttp(res, 'ERROR_GET_EXPENSES_KPI', error)
  }
}

export const getSimpleResultKPI = async ({ query, user }: RequestExt, res: Response): Promise<void> => {
  try {
    const result = await ExpenseService.getSimpleResult(query)

    // Emitir evento BI dashboard_simple_result_viewed
    emitSocket('dashboard', {
      action: 'simple_result_viewed',
      data: {
        event: 'dashboard_simple_result_viewed',
        timestamp: new Date().toISOString(),
        user: {
          id: user?.id,
          email: user?.email,
          name: user?.name
        },
        period: {
          from: query.from,
          to: query.to
        },
        filter: {
          onlyOperativeExpenses: query.onlyOperativeExpenses === 'true'
        },
        result: {
          totalSales: result.totalSales,
          totalBuys: result.totalBuys,
          totalExpenses: result.totalExpenses,
          expensesBreakdown: result.expensesBreakdown,
          simpleResult: result.simpleResult,
          currency: result.currency
        }
      }
    })

    res.status(200).json(result)
  } catch (error: any) {
    // Validaciones retornan 400
    if (
      error.message.includes('requeridos') ||
      error.message.includes('Formato inválido') ||
      error.message.includes('no puede ser posterior')
    ) {
      res.status(400).json({ error: error.message })
      return
    }
    handleHttp(res, 'ERROR_GET_SIMPLE_RESULT_KPI', error)
  }
}

