import { Schema, model } from 'mongoose'
import { IConfirmedItemMatch, MatchMethod } from '../interfaces/catalog.interface'

const ConfirmedItemMatchSchema = new Schema<IConfirmedItemMatch>(
  {
    providerId: {
      type: Schema.Types.ObjectId,
      ref: 'provider',
      required: [true, 'El proveedor es obligatorio'],
      index: true
    },
    rawDescription: {
      type: String,
      required: [true, 'La descripción raw es obligatoria'],
      trim: true
    },
    normalizedDescription: {
      type: String,
      required: [true, 'La descripción normalizada es obligatoria'],
      uppercase: true,
      trim: true
    },
    detected: {
      barcode: { type: String, trim: true },
      unit: { type: String, trim: true },
      qty: { type: Number }
    },
    chosen: {
      productId: {
        type: Schema.Types.ObjectId,
        ref: 'product',
        required: [true, 'El producto elegido es obligatorio']
      },
      method: {
        type: String,
        enum: Object.values(MatchMethod),
        required: [true, 'El método de match es obligatorio']
      },
      suggestionScore: { type: Number },
      suggestionRank: { type: Number }
    },
    doc: {
      draftId: { type: Schema.Types.ObjectId },
      buyId: { type: Schema.Types.ObjectId, ref: 'buy' },
      date: { type: Date },
      total: { type: Number }
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'user',
      required: [true, 'El usuario creador es obligatorio']
    }
  },
  {
    timestamps: { createdAt: true, updatedAt: false }, // Solo createdAt
    versionKey: false
  }
)

// ============================================
// ÍNDICES
// ============================================

// Índice para historial de confirmaciones por proveedor (analytics)
ConfirmedItemMatchSchema.index(
  { providerId: 1, createdAt: -1 },
  { name: 'idx_provider_history' }
)

// Índice para analizar qué productos se eligen más
ConfirmedItemMatchSchema.index(
  { providerId: 1, 'chosen.productId': 1 },
  { name: 'idx_provider_product_chosen' }
)

// Índice para buscar por descripción normalizada (debug/análisis)
ConfirmedItemMatchSchema.index(
  { providerId: 1, normalizedDescription: 1 },
  { name: 'idx_provider_normalized_desc' }
)

const ConfirmedItemMatchModel = model<IConfirmedItemMatch>('confirmedItemMatch', ConfirmedItemMatchSchema)
export default ConfirmedItemMatchModel
