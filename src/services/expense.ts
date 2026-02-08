import { Types } from 'mongoose'
import ExpenseModel from '../models/expense'
import BuyModel from '../models/buy'
import { IExpense, RELATED_KIND, CreateExpenseDTO, ListExpensesQuery } from '../interfaces/expense.interface'

class ExpenseService {
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

    const filter: any = { isDeleted: false }

    // Filtro por rango de fechas
    if (from || to) {
      filter.date = {}
      if (from) filter.date.$gte = new Date(from)
      if (to) filter.date.$lte = new Date(to)
    }

    // Filtros adicionales
    if (type) filter.type = type
    if (category) filter.category = category
    if (paymentMethod) filter.paymentMethod = paymentMethod

    // Búsqueda por texto (usa índice text)
    if (search) {
      filter.$text = { $search: search }
    }

    const skip = (page - 1) * limit

    const [expenses, total] = await Promise.all([
      ExpenseModel.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
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
        limit,
        pages: Math.ceil(total / limit)
      }
    }
  }

  async getById (id: string): Promise<IExpense | null> {
    return await ExpenseModel.findOne({ _id: id, isDeleted: false })
      .populate('createdBy', 'name email')
      .populate('updatedBy', 'name email')
  }

  async update (id: string, dto: Partial<CreateExpenseDTO>, userId: string): Promise<IExpense | null> {
    const expense = await ExpenseModel.findOne({ _id: id, isDeleted: false })
    if (!expense) {
      throw new Error('Egreso no encontrado')
    }

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

    return expense
  }

  async softDelete (id: string, userId: string): Promise<void> {
    const expense = await ExpenseModel.findOne({ _id: id, isDeleted: false })
    if (!expense) {
      throw new Error('Egreso no encontrado')
    }

    expense.isDeleted = true
    expense.deletedAt = new Date()
    expense.deletedBy = new Types.ObjectId(userId)
    await expense.save()
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
