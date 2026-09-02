import { Types } from 'mongoose'

/**
 * Criterio que disparó la advertencia de duplicado
 */
export enum DuplicateCriteria {
  DOC_NUMBER = 'DOC_NUMBER',
  PROVIDER_DATE_TOTAL = 'PROVIDER_DATE_TOTAL',
  FINGERPRINT = 'FINGERPRINT'
}

/**
 * Razones específicas de matching
 */
export enum MatchReason {
  DOC_NUMBER_EXACT = 'DOC_NUMBER_EXACT',
  FINGERPRINT_EXACT = 'FINGERPRINT_EXACT',
  DATE_WITHIN_DAYS = 'DATE_WITHIN_DAYS',
  TOTAL_WITHIN_TOLERANCE = 'TOTAL_WITHIN_TOLERANCE',
  TOTAL_EXACT = 'TOTAL_EXACT'
}

/**
 * Decisión del usuario ante advertencia de duplicado
 */
export enum DuplicateDecision {
  CANCEL = 'CANCEL',
  CONTINUE = 'CONTINUE',
  NOT_PROMPTED = 'NOT_PROMPTED'
}

/**
 * Recomendación del sistema
 */
export enum DuplicateRecommendation {
  PROMPT_USER = 'PROMPT_USER',
  NO_PROMPT = 'NO_PROMPT'
}

/**
 * Configuración de tolerancias para detección
 */
export interface ToleranceConfig {
  days?: number // Días de diferencia permitidos (default: 2)
  totalPct?: number // Porcentaje de diferencia en total (default: 0.01 = 1%)
  totalAbs?: number // Diferencia absoluta en total (default: 100)
}

/**
 * Candidato de duplicado detectado
 */
export interface DuplicateCandidate {
  existingBuyId: string
  existingDate?: Date | string
  existingTotal?: number
  existingDocNumber?: string
  existingFingerprint?: string
  score: number // 0.0 - 1.0
  reasons: MatchReason[]
  matchedOn: {
    docNumber?: boolean
    providerDateTotal?: boolean
    fingerprint?: boolean
  }
}

/**
 * Criterios que dispararon el matching
 */
export interface MatchCriteria {
  byDocNumber: boolean
  byProviderDateTotal: boolean
  byFingerprint: boolean
}

/**
 * DTO para request de check-duplicate
 */
export interface CheckDuplicateRequestDTO {
  providerId: string
  date: string // YYYY-MM-DD
  total: number
  docNumber?: string
  fingerprint?: string
  tolerance?: ToleranceConfig
}

/**
 * DTO para response de check-duplicate
 */
export interface CheckDuplicateResponseDTO {
  isPossibleDuplicate: boolean
  criteriaTriggered: DuplicateCriteria[]
  candidates: DuplicateCandidate[]
  recommendation: DuplicateRecommendation
  checkId?: string // ID del registro en purchase_doc_duplicate_checks
}

/**
 * DTO para request de duplicate-decision
 */
export interface DuplicateDecisionRequestDTO {
  decision: DuplicateDecision
  selectedExistingBuyId?: string
  criteriaTriggered: DuplicateCriteria[]
  candidates: DuplicateCandidate[]
}

/**
 * DTO para response de duplicate-decision
 */
export interface DuplicateDecisionResponseDTO {
  success: boolean
  message: string
  checkId: string
}

/**
 * Interface del modelo de MongoDB
 */
export interface PurchaseDocDuplicateCheck {
  _id?: Types.ObjectId
  draftId?: Types.ObjectId
  buyId?: Types.ObjectId
  expenseId?: Types.ObjectId
  providerId: Types.ObjectId
  date: Date
  total: number
  currency?: string
  docNumber?: string
  fingerprint?: string
  matchCriteria: MatchCriteria
  candidates: Array<{
    existingBuyId: Types.ObjectId
    score: number
    reasons: MatchReason[]
    matchedOn: {
      docNumber?: boolean
      providerDateTotal?: boolean
      fingerprint?: boolean
    }
  }>
  decision: DuplicateDecision
  decidedAt?: Date
  decidedBy?: Types.ObjectId
  createdAt?: Date
  updatedAt?: Date
}
