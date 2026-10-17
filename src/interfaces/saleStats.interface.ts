import type { Types } from 'mongoose'

export const STATS_PERIOD = {
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
  YEAR: 'year',
  CUSTOM: 'custom'
} as const

export type StatsPeriod = (typeof STATS_PERIOD)[keyof typeof STATS_PERIOD]

export const STATS_SCOPE = {
  BY_USER: 'by-user',
  OVERVIEW: 'overview'
} as const

export type StatsScope = (typeof STATS_SCOPE)[keyof typeof STATS_SCOPE]

export const STATS_VALIDATION_ERROR = {
  INVALID_REQUEST_BODY: 'INVALID_REQUEST_BODY',
  INVALID_PERIOD: 'INVALID_PERIOD',
  INVALID_TIMEZONE: 'INVALID_TIMEZONE',
  INVALID_INCLUDE_CANCELLED: 'INVALID_INCLUDE_CANCELLED',
  CUSTOM_RANGE_REQUIRED: 'CUSTOM_RANGE_REQUIRED',
  INVALID_FROM_DATE: 'INVALID_FROM_DATE',
  INVALID_TO_DATE: 'INVALID_TO_DATE',
  INVALID_DATE_RANGE: 'INVALID_DATE_RANGE',
  INVALID_USER_ID: 'INVALID_USER_ID',
  USER_ID_NOT_ALLOWED: 'USER_ID_NOT_ALLOWED'
} as const

export type StatsValidationErrorCode = (typeof STATS_VALIDATION_ERROR)[keyof typeof STATS_VALIDATION_ERROR]

export interface SaleStatsRequest {
  period?: string
  from?: string
  to?: string
  timezone?: string
  includeCancelled?: boolean
  userId?: string
}

export interface SaleStatsSummary {
  totalSalesCount: number
  totalAmount: number
  activeSellersCount: number
  averageTicket: number
  from: string
  to: string
  generatedAt: string
}

export interface SaleStatsByUserItem {
  userId: string
  nickname: string
  roleName: string | null
  salesCount: number
  totalAmount: number
  averageTicket: number
}

export interface SaleStatsByUserResponse {
  summary: SaleStatsSummary
  items: SaleStatsByUserItem[]
}

export interface SaleStatsOverviewResponse {
  summary: SaleStatsSummary
}

export interface ResolvedStatsRequest {
  period: StatsPeriod
  timezone: string
  includeCancelled: boolean
  from: Date
  to: Date
  fromIso: string
  toIso: string
  generatedAt: Date
  scope: StatsScope
  userId?: string
  userObjectId?: Types.ObjectId
}

export interface StatsDateRange {
  from: Date
  to: Date
  fromIso: string
  toIso: string
}

export interface StatsValidationError {
  code: StatsValidationErrorCode
  message: string
  field?: keyof SaleStatsRequest
}

export interface StatsValidationSuccess<T> {
  ok: true
  value: T
}

export interface StatsValidationFailure {
  ok: false
  status: 400
  error: StatsValidationError
}

export type StatsValidationResult<T> = StatsValidationSuccess<T> | StatsValidationFailure

export interface ParseSaleStatsRequestOptions {
  allowUserId?: boolean
  now?: Date
  scope?: StatsScope
}

export interface SaleStatsSummaryAggregationRow {
  totalSalesCount: number
  totalAmount: number
  activeSellersCount: number
}

export interface SaleStatsByUserAggregationRow extends SaleStatsByUserItem {
  _id?: string
}
