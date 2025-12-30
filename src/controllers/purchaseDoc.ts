import { Request, Response } from 'express'
import { Types } from 'mongoose'
import { JwtPayload } from 'jsonwebtoken'
import { handleHttp } from '../utils/error.handle'
import {
  createDraft,
  processDraft,
  getDraftById,
  confirmDraft,
  listUserDrafts
} from '../services/purchaseDoc'
import { getRelativePath } from '../middleware/uploadPurchaseDocs'
import {
  DraftStatus,
  SourceType,
  ConfirmPurchaseDocRequest,
  CreateDraftUploadResponse
} from '../interfaces/draftPurchaseDoc.interface'

interface RequestExt extends Request {
  user?: string | JwtPayload | undefined | any
}

/**
 * POST /purchase-docs/upload
 * Sube archivo, crea draft, analiza con AI y ejecuta duplicate check
 */
export const uploadPurchaseDoc = async (req: RequestExt, res: Response): Promise<void> => {
  try {
    // Validar que existe archivo (ya validado por middleware validateFileExists)
    if (!req.file) {
      res.status(400).json({
        success: false,
        error: 'Archivo requerido'
      })
      return
    }

    // Extraer datos del body
    const { providerId, sourceType } = req.body
    const userId = new Types.ObjectId(req.user.id)

    // Validar sourceType
    if (!sourceType || !Object.values(SourceType).includes(sourceType)) {
      res.status(400).json({
        success: false,
        error: 'sourceType inválido',
        details: {
          received: sourceType,
          allowed: Object.values(SourceType)
        }
      })
      return
    }

    // Validar providerId si se proporciona
    let providerObjectId: Types.ObjectId | undefined
    if (providerId) {
      if (!Types.ObjectId.isValid(providerId)) {
        res.status(400).json({
          success: false,
          error: 'providerId inválido',
          details: { providerId }
        })
        return
      }
      providerObjectId = new Types.ObjectId(providerId)
    }

    // Construir metadata del archivo
    const fileMetadata = {
      filename: req.file.filename,
      originalName: req.file.originalname,
      path: getRelativePath(req.file.path),
      mimeType: req.file.mimetype,
      size: req.file.size
    }

    console.log(`[Upload] Archivo recibido: ${fileMetadata.filename} (${fileMetadata.size} bytes)`)

    // Crear draft en estado PROCESSING
    const draft = await createDraft({
      file: fileMetadata,
      providerId: providerObjectId,
      sourceType: sourceType as SourceType,
      userId,
      status: DraftStatus.PROCESSING
    })

    console.log(`[Upload] Draft creado: ${draft._id}`)

    // Procesar draft de forma asíncrona (análisis + duplicate check)
    // NOTA: En producción considerar usar una cola de jobs (Bull, BullMQ)
    processDraft(draft._id as Types.ObjectId)
      .then(() => {
        console.log(`[Upload] Draft ${draft._id} procesado correctamente`)
      })
      .catch(error => {
        console.error(`[Upload] Error procesando draft ${draft._id}:`, error)
      })

    // Responder inmediatamente con draft en PROCESSING
    // La UI puede consultar el estado después con GET /purchase-docs/:draftId
    const response: CreateDraftUploadResponse = {
      draftId: draft._id!.toString(),
      status: draft.status,
      file: fileMetadata,
      providerId: providerObjectId?.toString(),
      sourceType: draft.sourceType
    }

    res.status(200).json({
      success: true,
      data: response,
      message: 'Archivo cargado, análisis en progreso'
    })
  } catch (error) {
    console.error('[Upload] Error:', error)
    handleHttp(res, 'ERROR_UPLOAD_PURCHASE_DOC', error)
  }
}

/**
 * GET /purchase-docs/:draftId
 * Obtiene el estado actual de un draft
 */
export const getDraftStatus = async (req: RequestExt, res: Response): Promise<void> => {
  try {
    const { draftId } = req.params

    if (!Types.ObjectId.isValid(draftId)) {
      res.status(400).json({
        success: false,
        error: 'draftId inválido'
      })
      return
    }

    const draft = await getDraftById(new Types.ObjectId(draftId))

    if (!draft) {
      res.status(404).json({
        success: false,
        error: 'Draft no encontrado'
      })
      return
    }

    // Verificar que el draft pertenece al usuario
    if (draft.userId.toString() !== req.user.id) {
      res.status(403).json({
        success: false,
        error: 'No tiene permisos para acceder a este draft'
      })
      return
    }

    // Construir respuesta según estado
    const response: CreateDraftUploadResponse = {
      draftId: draft._id!.toString(),
      status: draft.status,
      file: draft.file,
      providerId: draft.providerId?.toString(),
      sourceType: draft.sourceType,
      analysis: draft.analysisResult,
      possibleDuplicate: draft.possibleDuplicate,
      error: draft.error
    }

    res.status(200).json({
      success: true,
      data: response
    })
  } catch (error) {
    handleHttp(res, 'ERROR_GET_DRAFT_STATUS', error)
  }
}

/**
 * GET /purchase-docs
 * Lista drafts del usuario con filtros
 */
export const listDrafts = async (req: RequestExt, res: Response): Promise<void> => {
  try {
    const userId = new Types.ObjectId(req.user.id)
    const { skip = 0, limit = 50, status } = req.query

    // Validar status si se proporciona
    if (status && !Object.values(DraftStatus).includes(status as DraftStatus)) {
      res.status(400).json({
        success: false,
        error: 'status inválido',
        details: {
          received: status,
          allowed: Object.values(DraftStatus)
        }
      })
      return
    }

    const options = {
      skip: parseInt(skip as string, 10),
      limit: parseInt(limit as string, 10),
      status: status as DraftStatus | undefined
    }

    const result = await listUserDrafts(userId, options)

    res.status(200).json({
      success: true,
      data: {
        drafts: result.drafts,
        total: result.total,
        skip: options.skip,
        limit: options.limit
      }
    })
  } catch (error) {
    handleHttp(res, 'ERROR_LIST_DRAFTS', error)
  }
}

/**
 * POST /purchase-docs/:draftId/confirm
 * Confirma un draft y crea la compra definitiva
 */
export const confirmPurchaseDoc = async (req: RequestExt, res: Response): Promise<void> => {
  try {
    const { draftId } = req.params
    const userId = new Types.ObjectId(req.user.id)
    const body: ConfirmPurchaseDocRequest = req.body

    // Validar draftId
    if (!Types.ObjectId.isValid(draftId)) {
      res.status(400).json({
        success: false,
        error: 'draftId inválido'
      })
      return
    }

    // Validar que draft existe
    const draft = await getDraftById(new Types.ObjectId(draftId))
    if (!draft) {
      res.status(404).json({
        success: false,
        error: 'Draft no encontrado'
      })
      return
    }

    // Verificar que el draft pertenece al usuario
    if (draft.userId.toString() !== userId.toString()) {
      res.status(403).json({
        success: false,
        error: 'No tiene permisos para confirmar este draft'
      })
      return
    }

    // Validar que draft está READY
    if (draft.status !== DraftStatus.READY) {
      res.status(400).json({
        success: false,
        error: `Draft no puede ser confirmado. Estado actual: ${draft.status}`,
        details: {
          currentStatus: draft.status,
          requiredStatus: DraftStatus.READY
        }
      })
      return
    }

    // Validar items
    if (!body.items || body.items.length === 0) {
      // Si no se envían items, intentar usar los del análisis
      if (!draft.analysisResult?.items || draft.analysisResult.items.length === 0) {
        res.status(400).json({
          success: false,
          error: 'No hay items para confirmar'
        })
        return
      }
    }

    // Validar que cada item tiene productId o newProduct
    if (body.items && body.items.length > 0) {
      for (const item of body.items) {
        if (!item.chosenProductId && !item.newProduct) {
          res.status(400).json({
            success: false,
            error: 'Cada item debe tener chosenProductId o newProduct',
            details: {
              lineId: item.lineId,
              message: 'Item sin producto asignado'
            }
          })
          return
        }

        // Validar estructura de newProduct si existe
        if (item.newProduct) {
          const required = ['descripcion', 'categoria', 'marca', 'proveedor']
          for (const field of required) {
            if (!item.newProduct[field as keyof typeof item.newProduct]) {
              res.status(400).json({
                success: false,
                error: `Campo requerido en newProduct: ${field}`,
                details: {
                  lineId: item.lineId,
                  field
                }
              })
              return
            }
          }
        }
      }
    }

    // Confirmar draft
    console.log(`[Confirm] Confirmando draft ${draftId}`)
    const result = await confirmDraft(
      new Types.ObjectId(draftId),
      userId,
      body.headerEdits,
      body.items,
      body.duplicateDecision
    )

    res.status(200).json({
      success: true,
      data: {
        buyId: result.buyId.toString(),
        draftId: result.draftId.toString(),
        status: DraftStatus.CONFIRMED
      },
      message: 'Compra confirmada exitosamente'
    })
  } catch (error) {
    console.error('[Confirm] Error:', error)
    handleHttp(res, 'ERROR_CONFIRM_PURCHASE_DOC', error)
  }
}
