import { Types } from 'mongoose'
import BuyModel from '../models/buy'
import PurchaseDocDuplicateCheckModel from '../models/purchaseDocDuplicateCheck'
import { insertLog } from './log'
import {
  CheckDuplicateRequestDTO,
  CheckDuplicateResponseDTO,
  DuplicateCandidate,
  DuplicateCriteria,
  DuplicateDecision,
  DuplicateRecommendation,
  MatchReason,
  ToleranceConfig
} from '../interfaces/duplicateCheck.interface'

/**
 * Configuración por defecto de tolerancias
 */
const DEFAULT_TOLERANCE: Required<ToleranceConfig> = {
  days: 2,
  totalPct: 0.01, // 1%
  totalAbs: 100
}

/**
 * Umbral de score para considerar duplicado
 */
const DUPLICATE_THRESHOLD = 0.80

/**
 * Detecta posibles duplicados en el sistema
 * @param dto - Datos del documento a verificar
 * @param draftId - ID del draft (opcional)
 * @param userId - ID del usuario que ejecuta la verificación
 * @returns Resultado de la verificación con candidatos y recomendación
 */
export const checkForDuplicates = async (
  dto: CheckDuplicateRequestDTO,
  draftId?: string,
  userId?: string
): Promise<CheckDuplicateResponseDTO> => {
  const tolerance: Required<ToleranceConfig> = {
    ...DEFAULT_TOLERANCE,
    ...dto.tolerance
  }

  const candidates: DuplicateCandidate[] = []
  const criteriaTriggered: DuplicateCriteria[] = []

  // 1. Búsqueda por docNumber exacto
  if (dto.docNumber) {
    const docNumberCandidates = await findByDocNumber(
      dto.providerId,
      dto.docNumber
    )
    if (docNumberCandidates.length > 0) {
      criteriaTriggered.push(DuplicateCriteria.DOC_NUMBER)
      candidates.push(...docNumberCandidates)
    }
  }

  // 2. Búsqueda por fingerprint exacto
  if (dto.fingerprint) {
    const fingerprintCandidates = await findByFingerprint(
      dto.providerId,
      dto.fingerprint
    )
    if (fingerprintCandidates.length > 0) {
      criteriaTriggered.push(DuplicateCriteria.FINGERPRINT)
      candidates.push(...fingerprintCandidates)
    }
  }

  // 3. Búsqueda por proveedor + fecha + total (con tolerancias)
  const providerDateTotalCandidates = await findByProviderDateTotal(
    dto.providerId,
    new Date(dto.date),
    dto.total,
    tolerance
  )
  if (providerDateTotalCandidates.length > 0) {
    criteriaTriggered.push(DuplicateCriteria.PROVIDER_DATE_TOTAL)
    candidates.push(...providerDateTotalCandidates)
  }

  // 4. Deduplicar candidatos por buyId (puede aparecer por múltiples criterios)
  const uniqueCandidates = deduplicateCandidates(candidates)

  // 5. Calcular scoring final y aplicar boost
  const scoredCandidates = calculateFinalScores(uniqueCandidates)

  // 6. Determinar si se debe mostrar advertencia
  const isPossibleDuplicate = scoredCandidates.some(
    (c) => c.score >= DUPLICATE_THRESHOLD
  )

  const recommendation = isPossibleDuplicate
    ? DuplicateRecommendation.PROMPT_USER
    : DuplicateRecommendation.NO_PROMPT

  // 7. Persistir el check en la BD
  const checkRecord = await PurchaseDocDuplicateCheckModel.create({
    draftId: draftId ? new Types.ObjectId(draftId) : undefined,
    providerId: new Types.ObjectId(dto.providerId),
    date: new Date(dto.date),
    total: dto.total,
    docNumber: dto.docNumber,
    fingerprint: dto.fingerprint,
    matchCriteria: {
      byDocNumber: criteriaTriggered.includes(DuplicateCriteria.DOC_NUMBER),
      byProviderDateTotal: criteriaTriggered.includes(
        DuplicateCriteria.PROVIDER_DATE_TOTAL
      ),
      byFingerprint: criteriaTriggered.includes(DuplicateCriteria.FINGERPRINT)
    },
    candidates: scoredCandidates.map((c) => ({
      existingBuyId: new Types.ObjectId(c.existingBuyId),
      score: c.score,
      reasons: c.reasons,
      matchedOn: c.matchedOn
    })),
    decision: DuplicateDecision.NOT_PROMPTED
  })

  // 8. Registrar en logs de auditoría
  await insertLog({
    userId: userId ? new Types.ObjectId(userId) : undefined,
    accion: 'DUPLICATE_CHECK_RUN',
    coleccion: 'purchase_doc_duplicate_check',
    idColeccion: checkRecord._id,
    metadata: {
      checkId: checkRecord._id,
      draftId,
      providerId: dto.providerId,
      isPossibleDuplicate,
      candidatesCount: scoredCandidates.length,
      criteriaTriggered
    }
  })

  return {
    isPossibleDuplicate,
    criteriaTriggered,
    candidates: scoredCandidates,
    recommendation,
    checkId: checkRecord._id?.toString()
  }
}

/**
 * Registra la decisión del usuario sobre el duplicado
 * @param checkId - ID del check ejecutado
 * @param decision - Decisión tomada (CANCEL o CONTINUE)
 * @param userId - ID del usuario que decide
 * @param selectedExistingBuyId - ID de compra existente si seleccionó una
 */
export const recordDecision = async (
  checkId: string,
  decision: DuplicateDecision,
  userId: string,
  selectedExistingBuyId?: string
): Promise<void> => {
  const checkRecord = await PurchaseDocDuplicateCheckModel.findByIdAndUpdate(
    checkId,
    {
      decision,
      decidedAt: new Date(),
      decidedBy: new Types.ObjectId(userId)
    },
    { new: true }
  )

  if (checkRecord == null) {
    throw new Error('CHECK_NOT_FOUND')
  }

  // Registrar en logs de auditoría
  await insertLog({
    userId: new Types.ObjectId(userId),
    accion: 'DUPLICATE_DECISION',
    coleccion: 'purchase_doc_duplicate_check',
    idColeccion: checkRecord._id,
    metadata: {
      checkId,
      decision,
      selectedExistingBuyId,
      draftId: checkRecord.draftId?.toString(),
      candidatesCount: checkRecord.candidates.length
    }
  })
}

/**
 * Busca compras por número de documento exacto
 */
async function findByDocNumber (
  providerId: string,
  docNumber: string
): Promise<DuplicateCandidate[]> {
  const buys = await BuyModel.find({
    proveedor: providerId,
    docNumber
  })
    .select('_id fecha total docNumber fingerprint')
    .limit(5)
    .lean()

  return buys.map((buy) => ({
    existingBuyId: buy._id.toString(),
    existingDate: buy.fecha,
    existingTotal: buy.total as number,
    existingDocNumber: buy.docNumber,
    existingFingerprint: buy.fingerprint,
    score: 0.95, // Base score para docNumber exacto
    reasons: [MatchReason.DOC_NUMBER_EXACT],
    matchedOn: {
      docNumber: true,
      providerDateTotal: false,
      fingerprint: false
    }
  }))
}

/**
 * Busca compras por fingerprint exacto
 */
async function findByFingerprint (
  providerId: string,
  fingerprint: string
): Promise<DuplicateCandidate[]> {
  const buys = await BuyModel.find({
    proveedor: providerId,
    fingerprint
  })
    .select('_id fecha total docNumber fingerprint')
    .limit(5)
    .lean()

  return buys.map((buy) => ({
    existingBuyId: buy._id.toString(),
    existingDate: buy.fecha,
    existingTotal: buy.total as number,
    existingDocNumber: buy.docNumber,
    existingFingerprint: buy.fingerprint,
    score: 0.90, // Base score para fingerprint exacto
    reasons: [MatchReason.FINGERPRINT_EXACT],
    matchedOn: {
      docNumber: false,
      providerDateTotal: false,
      fingerprint: true
    }
  }))
}

/**
 * Busca compras por proveedor + fecha + total con tolerancias
 */
async function findByProviderDateTotal (
  providerId: string,
  date: Date,
  total: number,
  tolerance: Required<ToleranceConfig>
): Promise<DuplicateCandidate[]> {
  // Calcular rangos
  const dateMin = new Date(date)
  dateMin.setDate(dateMin.getDate() - tolerance.days)

  const dateMax = new Date(date)
  dateMax.setDate(dateMax.getDate() + tolerance.days)

  const totalTolerance = Math.max(
    tolerance.totalAbs,
    total * tolerance.totalPct
  )
  const totalMin = total - totalTolerance
  const totalMax = total + totalTolerance

  const buys = await BuyModel.find({
    proveedor: providerId,
    fecha: { $gte: dateMin, $lte: dateMax },
    total: { $gte: totalMin, $lte: totalMax }
  })
    .select('_id fecha total docNumber fingerprint')
    .limit(10)
    .lean()

  return buys.map((buy) => {
    const reasons: MatchReason[] = [MatchReason.DATE_WITHIN_DAYS]

    // Verificar si el total es exacto o dentro de tolerancia
    if (buy.total === total) {
      reasons.push(MatchReason.TOTAL_EXACT)
    } else {
      reasons.push(MatchReason.TOTAL_WITHIN_TOLERANCE)
    }

    return {
      existingBuyId: buy._id.toString(),
      existingDate: buy.fecha,
      existingTotal: buy.total as number,
      existingDocNumber: buy.docNumber,
      existingFingerprint: buy.fingerprint,
      score: 0.75, // Base score para provider+date+total
      reasons,
      matchedOn: {
        docNumber: false,
        providerDateTotal: true,
        fingerprint: false
      }
    }
  })
}

/**
 * Deduplicar candidatos que aparecen por múltiples criterios
 */
function deduplicateCandidates (
  candidates: DuplicateCandidate[]
): DuplicateCandidate[] {
  const candidateMap = new Map<string, DuplicateCandidate>()

  for (const candidate of candidates) {
    const existing = candidateMap.get(candidate.existingBuyId)

    if (existing != null) {
      // Merge: combinar reasons y matchedOn
      existing.reasons = Array.from(
        new Set([...existing.reasons, ...candidate.reasons])
      )
      existing.matchedOn = {
        docNumber: existing.matchedOn.docNumber || candidate.matchedOn.docNumber,
        providerDateTotal:
          existing.matchedOn.providerDateTotal ||
          candidate.matchedOn.providerDateTotal,
        fingerprint:
          existing.matchedOn.fingerprint || candidate.matchedOn.fingerprint
      }
      // Tomar el score más alto
      existing.score = Math.max(existing.score, candidate.score)
    } else {
      candidateMap.set(candidate.existingBuyId, { ...candidate })
    }
  }

  return Array.from(candidateMap.values())
}

/**
 * Calcular scores finales y aplicar boost por múltiples criterios
 */
function calculateFinalScores (
  candidates: DuplicateCandidate[]
): DuplicateCandidate[] {
  return candidates.map((candidate) => {
    let finalScore = candidate.score

    // Boost si coinciden 2 o más criterios
    const matchCount =
      (candidate.matchedOn.docNumber ? 1 : 0) +
      (candidate.matchedOn.providerDateTotal ? 1 : 0) +
      (candidate.matchedOn.fingerprint ? 1 : 0)

    if (matchCount >= 2) {
      finalScore += 0.1
    }

    // Clamp entre 0 y 1
    finalScore = Math.min(1.0, Math.max(0.0, finalScore))

    return {
      ...candidate,
      score: Math.round(finalScore * 100) / 100 // Redondear a 2 decimales
    }
  })
}
