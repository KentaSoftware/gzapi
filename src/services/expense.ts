import { Types } from 'mongoose'
import ExpenseModel from '../models/expense'
import BuyModel from '../models/buy'
import { IExpense, RELATED_KIND, CreateExpenseDTO, ListExpensesQuery } from '../interfaces/expense.interface'
import { insertLog } from './log'
import { emitSocket } from '../socket'

class ExpenseService {
  // Función auxiliar para calcular campos modificados
  private calculateChangedFields(
    before: any,
    after: any,
    fields: string[]
  ): Record<string, { before: any; after: any }> {
    const changes: Record<string, { before: any; after: any }> = {}

    fields.forEach(field => {
      const beforeValue = before[field]
      const afterValue = after[field]

      // Comparación profunda para objetos
      if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) {
        changes[field] = {
          before: beforeValue,
          after: afterValue
        }
      }
    })

    return changes
  }

  async create (dto: CreateExpenseDTO, userId: string): Promise<IExpense> {
    // Validar fecha no futura
    const expenseDate = new Date(dto.date)
    const now = new Date()
    if (expenseDate > now) {
      throw new Error('La fecha no puede ser futura')
    }

    // Convertir amount a amountCents
    const amountCents = Math.round(dto.amount * 100)
    if (amountCents < 1) {
      throw new Error('El monto debe ser mayor a 0')
    }

    // Validar relatedTo si es BUY
    if (dto.relatedTo?.kind === RELATED_KIND.BUY) {
      if (!dto.relatedTo.id) {
        throw new Error('Si relatedTo.kind es BUY, el id es obligatorio')
      }
      const buyExists = await BuyModel.findById(dto.relatedTo.id)
      if (!buyExists) {
        throw new Error('La compra referenciada no existe')
      }
    }

    const expense = await ExpenseModel.create({
      date: expenseDate,
      amountCents,
      category: dto.category,
      type: dto.type,
      paymentMethod: dto.paymentMethod,
      description: dto.description,
      relatedTo: dto.relatedTo || { kind: RELATED_KIND.NONE },
      createdBy: new Types.ObjectId(userId)
    })

    return expense
  }

  async list (query: ListExpensesQuery) {
    const {
      from,
      to,
      type,
      category,
      paymentMethod,
      search,
      page = 1,
      limit = 20,
      sort = '-date'
    } = query

    // Validar límite máximo
    const MAX_LIMIT = 100
    const effectiveLimit = Math.min(limit, MAX_LIMIT)
    
    if (limit > MAX_LIMIT) {
      throw new Error(`Límite máximo permitido es ${MAX_LIMIT}`)
    }

    const filter: any = { isDeleted: false }

    // Aplicar rango por defecto "mes actual" si no hay from/to
    let effectiveFrom = from
    let effectiveTo = to
    let defaultApplied = false

    if (!from && !to) {
      // Calcular mes actual en timezone del negocio (Argentina UTC-3)
      const now = new Date()
      const year = now.getFullYear()
      const month = now.getMonth() // 0-11
      
      effectiveFrom = new Date(year, month, 1).toISOString().split('T')[0]
      effectiveTo = new Date(year, month + 1, 0).toISOString().split('T')[0]
      defaultApplied = true
    }

    // Filtro por rango de fechas (siempre aplicado con default o custom)
    if (effectiveFrom || effectiveTo) {
      filter.date = {}
      if (effectiveFrom) filter.date.$gte = new Date(effectiveFrom)
      if (effectiveTo) filter.date.$lte = new Date(effectiveTo)
    }

    // Filtros adicionales
    if (type) filter.type = type
    if (category) filter.category = category
    if (paymentMethod) filter.paymentMethod = paymentMethod

    // Búsqueda por texto (usa índice text)
    if (search) {
      filter.$text = { $search: search }
    }

    const skip = (page - 1) * effectiveLimit

    // Sorting estable con fallback a createdAt
    const sortField = sort || '-date'
    const sortQuery: any = {}
    
    if (sortField.startsWith('-')) {
      const field = sortField.substring(1)
      sortQuery[field] = -1
      sortQuery.createdAt = -1  // Fallback para desempate
    } else {
      sortQuery[sortField] = 1
      sortQuery.createdAt = -1
    }

    const [expenses, total] = await Promise.all([
      ExpenseModel.find(filter)
        .sort(sortQuery)
        .skip(skip)
        .limit(effectiveLimit)
        .populate('createdBy', 'name email')
        .populate('updatedBy', 'name email')
        .lean(),
      ExpenseModel.countDocuments(filter)
    ])

    return {
      expenses,
      pagination: {
        total,
        page,
        limit: effectiveLimit,
        pages: Math.ceil(total / effectiveLimit)
      },
      // Metadatos para eventos BI
      _metadata: {
        effectiveFrom,
        effectiveTo,
        defaultApplied,
        appliedFilters: {
          type: type || null,
          category: category || null,
          paymentMethod: paymentMethod || null,
          search: search || null
        }
      }
    }
  }

  async getById (id: string): Promise<IExpense | null> {
    return await ExpenseModel.findOne({ _id: id, isDeleted: false })
      .populate('createdBy', 'name email')
      .populate('updatedBy', 'name email')
  }

  async update (id: string, dto: Partial<CreateExpenseDTO>, userId: string): Promise<IExpense | null> {
    // Validar ObjectId
    if (!Types.ObjectId.isValid(id)) {
      const error: any = new Error('ID de egreso inválido')
      error.status = 400
      throw error
    }

    // Buscar egreso
    const expense = await ExpenseModel.findById(id)
    
    if (!expense) {
      const error: any = new Error('Egreso no encontrado')
      error.status = 404
      throw error
    }

    // Verificar si está eliminado
    if (expense.isDeleted) {
      const error: any = new Error('El egreso ha sido eliminado y no puede ser editado')
      error.status = 410
      throw error
    }

    // Guardar snapshot antes de modificar
    const expenseBefore = expense.toObject()

    // Actualizar campos permitidos
    if (dto.date) {
      const expenseDate = new Date(dto.date)
      const now = new Date()
      if (expenseDate > now) {
        throw new Error('La fecha no puede ser futura')
      }
      expense.date = expenseDate
    }

    if (dto.amount !== undefined) {
      const amountCents = Math.round(dto.amount * 100)
      if (amountCents < 1) {
        throw new Error('El monto debe ser mayor a 0')
      }
      expense.amountCents = amountCents
    }

    if (dto.category) expense.category = dto.category
    if (dto.type) expense.type = dto.type as any
    if (dto.paymentMethod) expense.paymentMethod = dto.paymentMethod as any
    if (dto.description !== undefined) expense.description = dto.description

    // Validar y actualizar relatedTo
    if (dto.relatedTo) {
      if (dto.relatedTo.kind === RELATED_KIND.BUY) {
        if (!dto.relatedTo.id) {
          throw new Error('Si relatedTo.kind es BUY, el id es obligatorio')
        }
        const buyExists = await BuyModel.findById(dto.relatedTo.id)
        if (!buyExists) {
          throw new Error('La compra referenciada no existe')
        }
      }
      expense.relatedTo = dto.relatedTo as any
    }

    expense.updatedBy = new Types.ObjectId(userId)
    await expense.save()

    // Calcular campos modificados
    const expenseAfter = expense.toObject()
    const changedFields = this.calculateChangedFields(
      expenseBefore,
      expenseAfter,
      ['date', 'amountCents', 'category', 'type', 'paymentMethod', 'description', 'relatedTo']
    )

    // Solo registrar si hay cambios
    if (Object.keys(changedFields).length > 0) {
      // Registrar en logs
      await insertLog({
        accion: 'update',
        coleccion: 'expense',
        idColeccion: expense._id,
        userId: new Types.ObjectId(userId),
        changedFields: changedFields
      })

      // Emitir evento BI
      emitSocket('expense', {
        action: 'update',
        data: {
          event: 'expense_updated',
          timestamp: new Date().toISOString(),
          data: {
            id_egreso: expense._id.toString(),
            usuario: {
              id: userId
            },
            tipo_egreso: expense.type,
            categoria: expense.category,
            monto: expense.amountCents / 100,
            currency: expense.currency,
            campos_modificados: Object.keys(changedFields),
            changes: changedFields
          }
        }
      })
    }

    // Repoblar updatedBy
    await expense.populate('updatedBy', 'name email')
    await expense.populate('createdBy', 'name email')

    return expense
  }

  async softDelete (id: string, userId: string): Promise<IExpense> {
    // Validar ObjectId
    if (!Types.ObjectId.isValid(id)) {
      const error: any = new Error('ID de egreso inválido')
      error.status = 400
      throw error
    }

    // Buscar egreso (sin filtro isDeleted para manejar idempotencia)
    const expense = await ExpenseModel.findById(id)
    
    if (!expense) {
      const error: any = new Error('Egreso no encontrado')
      error.status = 404
      throw error
    }

    // Idempotencia: si ya está eliminado, retornar sin error
    if (expense.isDeleted) {
      await expense.populate('deletedBy', 'name email')
      await expense.populate('createdBy', 'name email')
      return expense
    }

    // Guardar metadata antes de eliminar
    const metadata = {
      monto: expense.amountCents / 100,
      tipo_egreso: expense.type,
      categoria: expense.category,
      medio_pago: expense.paymentMethod,
      fecha: expense.date,
      descripcion: expense.description,
      relatedTo: expense.relatedTo
    }

    // Realizar soft delete
    expense.isDeleted = true
    expense.deletedAt = new Date()
    expense.deletedBy = new Types.ObjectId(userId)
    await expense.save()

    // Registrar en logs con metadata
    await insertLog({
      accion: 'delete',
      coleccion: 'expense',
      idColeccion: expense._id,
      userId: new Types.ObjectId(userId),
      metadata: metadata
    })

    // Emitir evento BI
    emitSocket('expense', {
      action: 'delete',
      data: {
        event: 'expense_deleted',
        timestamp: new Date().toISOString(),
        data: {
          id_egreso: expense._id.toString(),
          usuario: {
            id: userId
          },
          tipo_egreso: expense.type,
          categoria: expense.category,
          monto: expense.amountCents / 100,
          currency: expense.currency,
          medio_pago: expense.paymentMethod,
          fecha: expense.date.toISOString(),
          relatedTo: expense.relatedTo
        }
      }
    })

    // Repoblar referencias
    await expense.populate('deletedBy', 'name email')
    await expense.populate('createdBy', 'name email')

    return expense
  }

  async listByBuy (buyId: string, query: ListExpensesQuery) {
    const filter: any = {
      isDeleted: false,
      'relatedTo.kind': RELATED_KIND.BUY,
      'relatedTo.id': new Types.ObjectId(buyId)
    }

    // Aplicar filtros adicionales si los hay
    if (query.from || query.to) {
      filter.date = {}
      if (query.from) filter.date.$gte = new Date(query.from)
      if (query.to) filter.date.$lte = new Date(query.to)
    }

    const expenses = await ExpenseModel.find(filter)
      .sort('-date')
      .populate('createdBy', 'name email')
      .lean()

    return { expenses }
  }
}

export default new ExpenseService()
