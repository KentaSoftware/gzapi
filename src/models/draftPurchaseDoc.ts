import { Schema, model } from 'mongoose'
import { DraftPurchaseDoc, DraftStatus, SourceType } from '../interfaces/draftPurchaseDoc.interface'

const FileMetadataSchema = new Schema(
  {
    filename: {
      type: String,
      required: true
    },
    originalName: {
      type: String,
      required: true
    },
    path: {
      type: String,
      required: true
    },
    mimeType: {
      type: String,
      required: true
    },
    size: {
      type: Number,
      required: true
    }
  },
  { _id: false }
)

const CatalogMatchSchema = new Schema(
  {
    productId: String,
    description: String,
    confidence: Number,
    method: String,
    source: String,
    candidates: [
      {
        productId: String,
        description: String,
        score: Number
      }
    ]
  },
  { _id: false }
)

const AnalyzedItemSchema = new Schema(
  {
    itemId: String,
    description: String,
    quantity: Number,
    unitPrice: Number,
    subtotal: Number,
    barcode: String,
    catalogMatch: CatalogMatchSchema
  },
  { _id: false }
)

const AnalyzedHeaderSchema = new Schema(
  {
    documentNumber: String,
    documentDate: String,
    providerName: String,
    providerId: String,
    total: Number,
    confidence: Number
  },
  { _id: false }
)

const AnalysisMetaSchema = new Schema(
  {
    itemsProcessed: Number,
    itemsWithMatch: Number,
    itemsWithoutMatch: Number,
    avgConfidence: Number,
    processingTime: Number,
    cacheVersion: String,
    batchSearchUsed: Boolean
  },
  { _id: false }
)

const AnalyzeResultSchema = new Schema(
  {
    header: AnalyzedHeaderSchema,
    items: [AnalyzedItemSchema],
    meta: AnalysisMetaSchema
  },
  { _id: false }
)

const DuplicateCandidateSchema = new Schema(
  {
    purchaseId: String,
    documentNumber: String,
    documentDate: String,
    providerId: String,
    total: Number,
    createdAt: Date,
    score: Number,
    reasons: [
      {
        strategy: String,
        match: Boolean,
        score: Number,
        boost: Number
      }
    ]
  },
  { _id: false }
)

const PossibleDuplicateSchema = new Schema(
  {
    checkId: String,
    status: String,
    duplicates: [DuplicateCandidateSchema],
    canProceed: Boolean,
    requiresDecision: Boolean,
    message: String
  },
  { _id: false }
)

const AnalysisErrorSchema = new Schema(
  {
    message: String,
    stack: String,
    code: String
  },
  { _id: false }
)

const DraftPurchaseDocSchema = new Schema<DraftPurchaseDoc>(
  {
    file: {
      type: FileMetadataSchema,
      required: true
    },
    providerId: {
      type: Schema.Types.ObjectId,
      ref: 'Provider',
      required: false
    },
    sourceType: {
      type: String,
      enum: Object.values(SourceType),
      required: true
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    status: {
      type: String,
      enum: Object.values(DraftStatus),
      required: true,
      default: DraftStatus.PROCESSING
    },
    analysisResult: {
      type: AnalyzeResultSchema,
      required: false
    },
    possibleDuplicate: {
      type: PossibleDuplicateSchema,
      required: false
    },
    error: {
      type: AnalysisErrorSchema,
      required: false
    },
    confirmedBuyId: {
      type: Schema.Types.ObjectId,
      ref: 'Buy',
      required: false
    },
    confirmedAt: {
      type: Date,
      required: false
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
)

// Índices para búsqueda eficiente
DraftPurchaseDocSchema.index({ userId: 1, createdAt: -1 })
DraftPurchaseDocSchema.index({ status: 1, createdAt: -1 })
DraftPurchaseDocSchema.index({ confirmedBuyId: 1 }, { sparse: true })

const DraftPurchaseDocModel = model<DraftPurchaseDoc>('draft_purchase_docs', DraftPurchaseDocSchema)
export default DraftPurchaseDocModel
