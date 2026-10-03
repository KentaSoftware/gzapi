import { Schema, model } from 'mongoose'
import { IExpense, EXPENSE_TYPE, PAYMENT_METHOD, RELATED_KIND } from '../interfaces/expense.interface'

const ExpenseSchema = new Schema<IExpense>(
  {
    date: {
      type: Date,
      required: [true, 'La fecha es obligatoria'],
      index: true
    },
    amountCents: {
      type: Number,
      required: [true, 'El monto es obligatorio'],
      min: [1, 'El monto debe ser mayor a 0'],
      validate: {
        validator: Number.isInteger,
        message: 'amountCents debe ser un entero'
      }
    },
    currency: {
      type: String,
      default: 'ARS',
      uppercase: true
    },
    category: {
      type: String,
      required: [true, 'La categoría es obligatoria'],
      trim: true,
      index: true
    },
    type: {
      type: String,
      enum: Object.values(EXPENSE_TYPE),
      required: [true, 'El tipo de egreso es obligatorio'],
      index: true
    },
    paymentMethod: {
      type: String,
      enum: Object.values(PAYMENT_METHOD),
      required: [true, 'El medio de pago es obligatorio'],
      index: true
    },
    description: {
      type: String,
      trim: true,
      maxlength: [500, 'La descripción no puede superar 500 caracteres']
    },
    relatedTo: {
      kind: {
        type: String,
        enum: Object.values(RELATED_KIND),
        default: RELATED_KIND.NONE,
        required: true
      },
      id: {
        type: Schema.Types.ObjectId,
        validate: {
          validator: function (this: IExpense, value: any) {
            // Si kind es BUY, id debe estar presente
            if (this.relatedTo.kind === RELATED_KIND.BUY) {
              return Boolean(value)
            }
            // Si kind es NONE, id debe ser null/undefined
            if (this.relatedTo.kind === RELATED_KIND.NONE) {
              const hasValue = Boolean(value)
              return !hasValue
            }
            return true
          },
          message: 'Si relatedTo.kind es BUY, el id es obligatorio'
        }
      }
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'user',
      required: [true, 'El usuario creador es obligatorio']
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'user'
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true
    },
    deletedAt: {
      type: Date
    },
    deletedBy: {
      type: Schema.Types.ObjectId,
      ref: 'user'
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
)

// Índices compuestos para performance
ExpenseSchema.index({ isDeleted: 1, date: -1 })
ExpenseSchema.index({ isDeleted: 1, type: 1, date: -1 })
ExpenseSchema.index({ isDeleted: 1, paymentMethod: 1, date: -1 })
ExpenseSchema.index({ isDeleted: 1, category: 1, date: -1 })
ExpenseSchema.index({ 'relatedTo.kind': 1, 'relatedTo.id': 1, isDeleted: 1 })
ExpenseSchema.index({ description: 'text' })

// Virtual para monto en formato decimal
ExpenseSchema.virtual('amount').get(function () {
  return this.amountCents / 100
})

// Configurar toJSON para incluir virtuals
ExpenseSchema.set('toJSON', {
  virtuals: true,
  transform: function (_doc, ret: any) {
    delete ret.isDeleted
    delete ret.deletedAt
    delete ret.deletedBy
    return ret
  }
})

const ExpenseModel = model<IExpense>('expense', ExpenseSchema)
export default ExpenseModel
