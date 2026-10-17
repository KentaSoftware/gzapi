import { Document, Types } from 'mongoose'

export enum EXPENSE_TYPE {
  OPERATIVO = 'operativo',
  PERSONAL = 'personal',
  OTRO_NEGOCIO = 'otro_negocio'
}

export enum PAYMENT_METHOD {
  EFECTIVO = 'efectivo',
  TRANSFERENCIA = 'transferencia',
  TARJETA = 'tarjeta',
  CHEQUE = 'cheque',
  OTRO = 'otro'
}

export enum RELATED_KIND {
  NONE = 'NONE',
  BUY = 'BUY'
}

export interface IRelatedTo {
  kind: RELATED_KIND
  id?: Types.ObjectId
}

export interface IExpense extends Document {
  date: Date
  amountCents: number
  currency: string
  category: string
  type: EXPENSE_TYPE
  paymentMethod: PAYMENT_METHOD
  description?: string
  relatedTo: IRelatedTo
  createdBy: Types.ObjectId
  updatedBy?: Types.ObjectId
  isDeleted: boolean
  deletedAt?: Date
  deletedBy?: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

export interface CreateExpenseDTO {
  date: string | Date
  amount: number
  category: string
  type: string
  paymentMethod: string
  description?: string
  relatedTo?: { kind: string, id?: string }
}

export interface ListExpensesQuery {
  preset?: 'today' | 'week' | 'month'
  from?: string
  to?: string
  type?: string
  category?: string
  paymentMethod?: string
  search?: string
  page?: number
  limit?: number
  sort?: string
}

export interface ExpensesKPIQuery {
  from: string
  to: string
  type?: string
}

export interface ExpensesKPIResponse {
  totalCents: number
  totalAmount: number
  currency: string
}

export interface SimpleResultKPIQuery {
  from: string
  to: string
  onlyOperativeExpenses?: string // "true" | "false"
}

export interface SimpleResultKPIResponse {
  totalSales: number
  totalBuys: number
  totalExpenses: number
  expensesBreakdown: {
    operative: number
    personal: number
    other: number
  }
  simpleResult: number
  currency: string
}
