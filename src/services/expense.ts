import { Types } from 'mongoose'
import ExpenseModel from '../models/expense'
import BuyModel from '../models/buy'
import SaleModel from '../models/sale'
import { IExpense, RELATED_KIND, CreateExpenseDTO, ListExpensesQuery, EXPENSE_TYPE, PAYMENT_METHOD, SimpleResultKPIResponse } from '../interfaces/expense.interface'
import { insertLog } from './log'
import { emitSocket } from '../socket'

class ExpenseService {
  // Función auxiliar para calcular campos modificados
  private calculateChangedFields (
    before: any,
    after: any,
    fields: string[]
  ): Record<string, { before: any, after: any }> {
    const changes: Record<string, { before: any, after: any }> = {}

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
      if (dto.relatedTo.id == null || dto.relatedTo.id === '') {
        throw new Error('Si relatedTo.kind es BUY, el id es obligatorio')
      }
      const buyExists = await BuyModel.findById(dto.relatedTo.id)
      if (buyExists == null) {
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
      relatedTo: (dto.relatedTo != null) || { kind: RELATED_KIND.NONE },
      createdBy: new Types.ObjectId(userId)
    })

    // Registrar en logs (auditoría completa)
    await insertLog({
      accion: 'create',
      coleccion: 'expense',
      idColeccion: expense._id,
      userId: new Types.ObjectId(userId),
      metadata: {
        monto: expense.amountCents / 100,
        tipo_egreso: expense.type,
        categoria: expense.category,
        medio_pago: expense.paymentMethod,
        fecha: expense.date,
        descripcion: expense.description != null && expense.description !== '' ? expense.description : null,
        relatedTo: expense.relatedTo
      }
    })

    // Emitir evento BI
    emitSocket('expense', {
      action: 'create',
      data: {
        event: 'expense_created',
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

    return expense
  }

  // Helpers para presets de fechas (timezone Argentina UTC-3)
  private getTodayDateRange (): [string, string] {
    const now = new Date()
    const todayStr = now.toISOString().split('T')[0]
    return [todayStr, todayStr]
  }

  private getCurrentWeekRange (): [string, string] {
    // Semana de lunes a domingo (ISO 8601)
    const now = new Date()
    const dayOfWeek = now.getDay() // 0=domingo, 1=lunes, ..., 6=sábado
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek

    const monday = new Date(now)
    monday.setDate(now.getDate() + mondayOffset)
    monday.setHours(0, 0, 0, 0)

    const sunday = new Date(monday)
    sunday.setDate(monday.getDate() + 6)
    sunday.setHours(23, 59, 59, 999)

    return [
      monday.toISOString().split('T')[0],
      sunday.toISOString().split('T')[0]
    ]
  }

  private getCurrentMonthRange (): [string, string] {
    const now = new Date()
    const year = now.getFullYear()
    const month = now.getMonth()

    const firstDay = new Date(year, month, 1)
    const lastDay = new Date(year, month + 1, 0)

    return [
      firstDay.toISOString().split('T')[0],
      lastDay.toISOString().split('T')[0]
    ]
  }

  // Validar formato YYYY-MM-DD y fecha real
  private isValidDateFormat (dateStr: string): boolean {
    const regex = /^\d{4}-\d{2}-\d{2}$/
    if (!regex.test(dateStr)) return false

    const date = new Date(dateStr + 'T00:00:00.000Z')
    return !isNaN(date.getTime())
  }

  async list (query: ListExpensesQuery) {
    const {
      preset,
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

    // VALIDACIÓN DE ENUMS (GAP-01)
    if (type != null && type !== '') {
      const validTypes = Object.values(EXPENSE_TYPE)
      if (!validTypes.includes(type as EXPENSE_TYPE)) {
        throw new Error(
          `Tipo de egreso inválido. Valores permitidos: ${validTypes.join(', ')}`
        )
      }
    }

    if (paymentMethod != null && paymentMethod !== '') {
      const validPaymentMethods = Object.values(PAYMENT_METHOD)
      if (!validPaymentMethods.includes(paymentMethod as PAYMENT_METHOD)) {
        throw new Error(
          `Medio de pago inválido. Valores permitidos: ${validPaymentMethods.join(', ')}`
        )
      }
    }

    // Normalización de case-sensitivity (GAP-02)
    const normalizedType = type?.toLowerCase()
    const normalizedPaymentMethod = paymentMethod?.toLowerCase()

    const filter: any = { isDeleted: false }

    // Determinar rango de fechas: preset > custom (from/to) > default (mes actual)
    let effectiveFrom: string | undefined
    let effectiveTo: string | undefined
    let tipoFiltro: 'rápido' | 'personalizado' | 'default'
    let presetUsed: string | null = null

    if (preset != null && String(preset) !== '') {
      // PRIORIDAD 1: Preset (today, week, month)
      if (!['today', 'week', 'month'].includes(preset)) {
        throw new Error("Preset inválido. Valores permitidos: 'today', 'week', 'month'")
      }

      switch (preset) {
        case 'today':
          [effectiveFrom, effectiveTo] = this.getTodayDateRange()
          break
        case 'week':
          [effectiveFrom, effectiveTo] = this.getCurrentWeekRange()
          break
        case 'month':
          [effectiveFrom, effectiveTo] = this.getCurrentMonthRange()
          break
      }

      tipoFiltro = 'rápido'
      presetUsed = preset
    } else if ((from != null && from !== '') || (to != null && to !== '')) {
      // PRIORIDAD 2: Rango personalizado (from/to)
      // Validar formato
      if (from != null && from !== '' && !this.isValidDateFormat(from)) {
        throw new Error('Formato inválido para \'from\'. Esperado: YYYY-MM-DD')
      }
      if (to != null && to !== '' && !this.isValidDateFormat(to)) {
        throw new Error('Formato inválido para \'to\'. Esperado: YYYY-MM-DD')
      }

      // Validar from <= to
      if (from != null && from !== '' && to != null && to !== '' && new Date(from) > new Date(to)) {
        throw new Error("La fecha 'from' no puede ser posterior a 'to'")
      }

      effectiveFrom = from
      effectiveTo = to
      tipoFiltro = 'personalizado'
      presetUsed = null
    } else {
      // PRIORIDAD 3: Default (mes actual)
      const now = new Date()
      const year = now.getFullYear()
      const month = now.getMonth() // 0-11

      effectiveFrom = new Date(year, month, 1).toISOString().split('T')[0]
      effectiveTo = new Date(year, month + 1, 0).toISOString().split('T')[0]
      tipoFiltro = 'default'
      presetUsed = null
    }

    // Filtro por rango de fechas (siempre aplicado)
    if ((effectiveFrom != null && effectiveFrom !== '') || (effectiveTo != null && effectiveTo !== '')) {
      filter.date = {}

      if (effectiveFrom != null && effectiveFrom !== '') {
        const fromDate = new Date(effectiveFrom + 'T00:00:00.000Z')
        filter.date.$gte = fromDate
      }

      if (effectiveTo != null && effectiveTo !== '') {
        // INCLUSIVIDAD CORREGIDA: incluir todo el día hasta 23:59:59.999
        const toDate = new Date(effectiveTo + 'T00:00:00.000Z')
        toDate.setHours(23, 59, 59, 999)
        filter.date.$lte = toDate
      }
    }

    // Filtros adicionales (usar valores normalizados)
    if (normalizedType != null && normalizedType !== '') filter.type = normalizedType
    if (category != null && category !== '') filter.category = category
    if (normalizedPaymentMethod != null && normalizedPaymentMethod !== '') filter.paymentMethod = normalizedPaymentMethod

    // Búsqueda por texto (usa índice text) con validaciones
    let trimmedSearch: string | null = null
    if (search != null && search !== '') {
      trimmedSearch = search.trim()

      // Ignorar si vacío después de trim
      if (trimmedSearch.length === 0) {
        trimmedSearch = null
      } else {
        // Validar longitud mínima
        if (trimmedSearch.length < 2) {
          throw new Error('El término de búsqueda debe tener al menos 2 caracteres')
        }

        // Validar longitud máxima
        if (trimmedSearch.length > 100) {
          throw new Error('El término de búsqueda no puede superar 100 caracteres')
        }

        // Aplicar búsqueda
        filter.$text = { $search: trimmedSearch }
      }
    }

    const skip = (page - 1) * effectiveLimit

    // Sorting estable con fallback a createdAt
    const sortField = sort !== '' ? sort : '-date'
    const sortQuery: any = {}

    if (sortField.startsWith('-')) {
      const field = sortField.substring(1)
      sortQuery[field] = -1
      sortQuery.createdAt = -1 // Fallback para desempate
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
        tipo_filtro: tipoFiltro,
        preset: presetUsed,
        appliedFilters: {
          type: normalizedType != null && normalizedType !== '' ? normalizedType : null,
          category: category != null && category !== '' ? category : null,
          paymentMethod: normalizedPaymentMethod != null && normalizedPaymentMethod !== '' ? normalizedPaymentMethod : null,
          search: trimmedSearch != null && trimmedSearch !== '' ? trimmedSearch : null // Usar término normalizado
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

    if (expense == null) {
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
    if (dto.date != null && dto.date !== '') {
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

    if (dto.category != null && dto.category !== '') expense.category = dto.category
    if (dto.type != null && dto.type !== '') expense.type = dto.type as any
    if (dto.paymentMethod != null && dto.paymentMethod !== '') expense.paymentMethod = dto.paymentMethod as any
    if (dto.description !== undefined) expense.description = dto.description

    // Validar y actualizar relatedTo
    if (dto.relatedTo != null) {
      if (dto.relatedTo.kind === RELATED_KIND.BUY) {
        if (dto.relatedTo.id == null || dto.relatedTo.id === '') {
          throw new Error('Si relatedTo.kind es BUY, el id es obligatorio')
        }
        const buyExists = await BuyModel.findById(dto.relatedTo.id)
        if (buyExists == null) {
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
        changedFields
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

    if (expense == null) {
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
      metadata
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
    if ((query.from != null && query.from !== '') || (query.to != null && query.to !== '')) {
      filter.date = {}
      if (query.from != null && query.from !== '') filter.date.$gte = new Date(query.from)
      if (query.to != null && query.to !== '') filter.date.$lte = new Date(query.to)
    }

    const expenses = await ExpenseModel.find(filter)
      .sort('-date')
      .populate('createdBy', 'name email')
      .lean()

    return { expenses }
  }

  async getExpensesTotal (query: any): Promise<any> {
    const { from, to, type } = query

    // Validar parámetros requeridos
    if (from == null || from === '' || to == null || to === '') {
      throw new Error('Los parámetros from y to son requeridos')
    }

    // Validar formato de fechas
    const fromDate = new Date(from)
    const toDate = new Date(to)

    if (isNaN(fromDate.getTime())) {
      throw new Error("Formato inválido para 'from'. Esperado: YYYY-MM-DD")
    }
    if (isNaN(toDate.getTime())) {
      throw new Error("Formato inválido para 'to'. Esperado: YYYY-MM-DD")
    }

    // Validar rango
    if (fromDate > toDate) {
      throw new Error("La fecha 'from' no puede ser posterior a 'to'")
    }

    // Ajustar toDate para incluir todo el día (hasta 23:59:59.999)
    const endOfDayDate = new Date(toDate)
    endOfDayDate.setHours(23, 59, 59, 999)

    // Construir $match
    // P7 audit: Home operational dashboard filters expenses by `Expense.date` (the operational
    // invoice date set by the user), NOT by Mongoose auto-timestamp `createdAt`.
    // This is intentional and correct for the Home operational view. See home-dashboard spec (P7).
    const matchStage: any = {
      isDeleted: false,
      date: {
        $gte: fromDate,
        $lte: endOfDayDate
      }
    }

    // Validar y normalizar type si viene
    if (type != null && type !== '') {
      const normalizedType = type.toLowerCase()
      const validTypes = Object.values(EXPENSE_TYPE)

      if (!validTypes.includes(normalizedType as EXPENSE_TYPE)) {
        throw new Error('Tipo de egreso inválido. Valores permitidos: operativo, personal, otro_negocio')
      }

      matchStage.type = normalizedType
    }

    // Aggregation pipeline
    const pipeline = [
      { $match: matchStage },
      {
        $group: {
          _id: null,
          totalCents: { $sum: '$amountCents' }
        }
      }
    ]

    const result = await ExpenseModel.aggregate(pipeline)
    const totalCents = result[0]?.totalCents ?? 0
    const totalAmount = parseFloat((totalCents / 100).toFixed(2))

    return {
      totalCents,
      totalAmount,
      currency: 'ARS'
    }
  }

  // Helper para redondear a 2 decimales (consistencia entre float y cents)
  private round2 (value: number): number {
    return parseFloat(value.toFixed(2))
  }

  /**
   * KPI Resultado Simple: Ventas - Compras - Egresos
   * Combina datos de 3 colecciones: Sales, Buys, Expenses
   * @param query - from, to (YYYY-MM-DD), onlyOperativeExpenses (opcional)
   * @returns SimpleResultKPIResponse con totales y breakdown
   */
  async getSimpleResult (query: any): Promise<SimpleResultKPIResponse> {
    const { from, to, onlyOperativeExpenses } = query

    // Validar parámetros requeridos
    if (from == null || from === '' || to == null || to === '') {
      throw new Error('Los parámetros from y to son requeridos')
    }

    // Validar formato de fechas
    const fromDate = new Date(from)
    const toDate = new Date(to)

    if (isNaN(fromDate.getTime())) {
      throw new Error("Formato inválido para 'from'. Esperado: YYYY-MM-DD")
    }
    if (isNaN(toDate.getTime())) {
      throw new Error("Formato inválido para 'to'. Esperado: YYYY-MM-DD")
    }

    // Validar rango
    if (fromDate > toDate) {
      throw new Error("La fecha 'from' no puede ser posterior a 'to'")
    }

    // Ajustar toDate para incluir todo el día (hasta 23:59:59.999)
    const endOfDayDate = new Date(toDate)
    endOfDayDate.setHours(23, 59, 59, 999)

    // Normalizar onlyOperativeExpenses
    const filterOnlyOperative = onlyOperativeExpenses === 'true'

    // Ejecutar 3 agregaciones en paralelo
    const [salesResult, buysResult, expensesResult] = await Promise.all([
      // 1. Total de Ventas (por createdAt)
      SaleModel.aggregate([
        {
          $match: {
            createdAt: {
              $gte: fromDate,
              $lte: endOfDayDate
            }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$total' }
          }
        }
      ]),

      // 2. Total de Compras (por createdAt)
      BuyModel.aggregate([
        {
          $match: {
            createdAt: {
              $gte: fromDate,
              $lte: endOfDayDate
            }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$total' }
          }
        }
      ]),

      // 3. Breakdown de Egresos (por date + type)
      // P7 audit: Expenses use `Expense.date` (operational invoice date), not `createdAt`.
      ExpenseModel.aggregate([
        {
          $match: {
            isDeleted: false,
            date: {
              $gte: fromDate,
              $lte: endOfDayDate
            }
          }
        },
        {
          $group: {
            _id: '$type',
            totalCents: { $sum: '$amountCents' }
          }
        }
      ])
    ])

    // Extraer totales con redondeo a 2 decimales
    const totalSales = this.round2(salesResult[0]?.total ?? 0)
    const totalBuys = this.round2(buysResult[0]?.total ?? 0)

    // Procesar breakdown de egresos
    const operative = expensesResult.find(e => e._id === EXPENSE_TYPE.OPERATIVO)?.totalCents ?? 0
    const personal = expensesResult.find(e => e._id === EXPENSE_TYPE.PERSONAL)?.totalCents ?? 0
    const other = expensesResult.find(e => e._id === EXPENSE_TYPE.OTRO_NEGOCIO)?.totalCents ?? 0

    const operativeAmount = this.round2(operative / 100)
    const personalAmount = this.round2(personal / 100)
    const otherAmount = this.round2(other / 100)
    const totalExpenses = this.round2(operativeAmount + personalAmount + otherAmount)

    // Calcular simpleResult según flag
    let simpleResult: number
    if (filterOnlyOperative) {
      simpleResult = this.round2(totalSales - totalBuys - operativeAmount)
    } else {
      simpleResult = this.round2(totalSales - totalBuys - totalExpenses)
    }

    return {
      totalSales,
      totalBuys,
      totalExpenses,
      expensesBreakdown: {
        operative: operativeAmount,
        personal: personalAmount,
        other: otherAmount
      },
      simpleResult,
      currency: 'ARS'
    }
  }
}

export default new ExpenseService()
