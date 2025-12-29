import { Schema, model } from 'mongoose'
import { PurchaseDocDuplicateCheck, DuplicateDecision } from '../interfaces/duplicateCheck.interface'

const PurchaseDocDuplicateCheckSchema = new Schema<PurchaseDocDuplicateCheck>(
  {
    draftId: {
      type: Schema.Types.ObjectId,
      required: false,
      index: true
    },
    buyId: {
      type: Schema.Types.ObjectId,
      ref: 'buy',
      required: false,
      index: true
    },
    expenseId: {
      type: Schema.Types.ObjectId,
      ref: 'expense',
      required: false
    },
    providerId: {
      type: Schema.Types.ObjectId,
      ref: 'provider',
      required: true,
      index: true
    },
    date: {
      type: Date,
      required: true
    },
    total: {
      type: Number,
      required: true
    },
    currency: {
      type: String,
      default: 'ARS'
    },
    docNumber: {
      type: String,
      required: false
    },
    fingerprint: {
      type: String,
      required: false
    },
    matchCriteria: {
      byDocNumber: { type: Boolean, default: false },
      byProviderDateTotal: { type: Boolean, default: false },
      byFingerprint: { type: Boolean, default: false }
    },
    candidates: [
      {
        existingBuyId: {
          type: Schema.Types.ObjectId,
          ref: 'buy',
          required: true
        },
        score: {
          type: Number,
          required: true,
          min: 0,
          max: 1
        },
        reasons: {
          type: [String],
          required: true
        },
        matchedOn: {
          docNumber: { type: Boolean, default: false },
          providerDateTotal: { type: Boolean, default: false },
          fingerprint: { type: Boolean, default: false }
        }
      }
    ],
    decision: {
      type: String,
      enum: Object.values(DuplicateDecision),
      default: DuplicateDecision.NOT_PROMPTED
    },
    decidedAt: {
      type: Date,
      required: false
    },
    decidedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: false
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
)

// Índice compuesto para búsquedas por proveedor y fecha
PurchaseDocDuplicateCheckSchema.index({ providerId: 1, createdAt: -1 })

// Índice para búsquedas por draft
PurchaseDocDuplicateCheckSchema.index({ draftId: 1 }, { sparse: true })

const PurchaseDocDuplicateCheckModel = model('purchase_doc_duplicate_check', PurchaseDocDuplicateCheckSchema)

export default PurchaseDocDuplicateCheckModel
