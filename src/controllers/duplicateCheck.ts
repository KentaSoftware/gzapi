import { Request, Response } from 'express'
import { handleHttp } from '../utils/error.handle'
import { checkForDuplicates, recordDecision } from '../services/duplicateCheck'
import {
  CheckDuplicateRequestDTO,
  DuplicateDecisionRequestDTO,
  DuplicateDecision
} from '../interfaces/duplicateCheck.interface'
import { JwtPayload } from 'jsonwebtoken'

interface RequestExt extends Request {
  user?: string | JwtPayload | undefined | any
}

/**
 * POST /api/purchase-docs/drafts/:draftId/check-duplicate
 * Verifica si existe un posible duplicado en el sistema
 */
export const checkDuplicate = async (req: RequestExt, res: Response) => {
  try {
    const { draftId } = req.params
    const dto: CheckDuplicateRequestDTO = req.body
    const userId = req.user?.id

    // Validaciones
    if (dto.providerId == null || dto.providerId === '') {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'providerId is required'
      })
    }

    if (dto.date == null || dto.date === '') {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'date is required (format: YYYY-MM-DD)'
      })
    }

    if (typeof dto.total !== 'number' || dto.total <= 0) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'total must be a positive number'
      })
    }

    // Validar formato de fecha
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/
    if (!dateRegex.test(dto.date)) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'date must be in format YYYY-MM-DD'
      })
    }

    // Ejecutar detección
    const result = await checkForDuplicates(dto, draftId, userId)

    return res.status(200).json(result)
  } catch (error) {
    console.error('[DUPLICATE_CHECK] Error:', error)
    return handleHttp(res, 'ERROR_CHECK_DUPLICATE', error)
  }
}

/**
 * POST /api/purchase-docs/drafts/:draftId/duplicate-decision
 * Registra la decisión del usuario ante una advertencia de duplicado
 */
export const registerDecision = async (req: RequestExt, res: Response) => {
  try {
    const { draftId } = req.params
    const dto: DuplicateDecisionRequestDTO = req.body
    const userId = req.user?.id

    if (userId == null || userId === '') {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'User not authenticated'
      })
    }

    // Validaciones
    if (dto.decision == null || String(dto.decision) === '') {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'decision is required'
      })
    }

    if (
      dto.decision !== DuplicateDecision.CANCEL &&
      dto.decision !== DuplicateDecision.CONTINUE
    ) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'decision must be CANCEL or CONTINUE'
      })
    }

    if (dto.criteriaTriggered == null || dto.criteriaTriggered.length === 0) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'criteriaTriggered is required'
      })
    }

    if (dto.candidates == null || dto.candidates.length === 0) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'candidates is required'
      })
    }

    // Buscar el último check asociado a este draft
    const PurchaseDocDuplicateCheckModel = (
      await import('../models/purchaseDocDuplicateCheck')
    ).default

    const checkRecord = await PurchaseDocDuplicateCheckModel.findOne({
      draftId
    }).sort({ createdAt: -1 })

    if (checkRecord == null) {
      return res.status(404).json({
        error: 'CHECK_NOT_FOUND',
        message: 'No duplicate check found for this draft'
      })
    }

    // Registrar decisión
    await recordDecision(
      checkRecord._id.toString(),
      dto.decision,
      userId,
      dto.selectedExistingBuyId
    )

    return res.status(200).json({
      success: true,
      message: 'Decision recorded successfully',
      checkId: checkRecord._id.toString()
    })
  } catch (error) {
    console.error('[DUPLICATE_DECISION] Error:', error)
    return handleHttp(res, 'ERROR_REGISTER_DECISION', error)
  }
}

/**
 * GET /api/purchase-docs/drafts/:draftId/duplicate-checks
 * Obtiene el historial de checks de duplicado para un draft
 */
export const getCheckHistory = async (req: RequestExt, res: Response) => {
  try {
    const { draftId } = req.params

    const PurchaseDocDuplicateCheckModel = (
      await import('../models/purchaseDocDuplicateCheck')
    ).default

    const checks = await PurchaseDocDuplicateCheckModel.find({
      draftId
    })
      .sort({ createdAt: -1 })
      .populate('decidedBy', 'nombre email')
      .lean()

    return res.status(200).json({
      success: true,
      count: checks.length,
      checks
    })
  } catch (error) {
    console.error('[DUPLICATE_CHECK_HISTORY] Error:', error)
    return handleHttp(res, 'ERROR_GET_CHECK_HISTORY', error)
  }
}
