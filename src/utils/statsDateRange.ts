import {
  endOfDay,
  endOfMonth,
  endOfWeek,
  endOfYear,
  startOfDay,
  startOfMonth,
  startOfWeek,
  startOfYear
} from 'date-fns'
import { fromZonedTime, getTimezoneOffset, toDate, toZonedTime } from 'date-fns-tz'
import { Types } from 'mongoose'
import {
  STATS_PERIOD,
  STATS_SCOPE,
  STATS_VALIDATION_ERROR,
  type ParseSaleStatsRequestOptions,
  type ResolvedStatsRequest,
  type SaleStatsRequest,
  type StatsDateRange,
  type StatsPeriod,
  type StatsValidationFailure,
  type StatsValidationResult,
  type StatsValidationSuccess
} from '../interfaces/saleStats.interface'

const DEFAULT_STATS_TIMEZONE = 'America/Argentina/Buenos_Aires'

const PERIOD_VALUES = new Set<string>(Object.values(STATS_PERIOD))

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

const buildValidationError = (
  code: typeof STATS_VALIDATION_ERROR[keyof typeof STATS_VALIDATION_ERROR],
  message: string,
  field?: keyof SaleStatsRequest
): StatsValidationFailure => {
  return {
    ok: false,
    status: 400,
    error: {
      code,
      message,
      field
    }
  }
}

const buildValidationSuccess = <T>(value: T): StatsValidationSuccess<T> => {
  return {
    ok: true,
    value
  }
}

export const isValidStatsTimezone = (timezone: string): boolean => {
  const offset = getTimezoneOffset(timezone, new Date())
  return Number.isFinite(offset)
}

export const isStatsPeriod = (value: string): value is StatsPeriod => {
  return PERIOD_VALUES.has(value)
}

export const normalizeCancelledState = (value: string | null | undefined): string => {
  if (value === null || value === undefined || value === '') return ''
  return value.trim().toLowerCase()
}

export const roundStatsAmount = (value: number): number => {
  return Number(value.toFixed(2))
}

export const calculateAverageTicket = (totalAmount: number, totalSalesCount: number): number => {
  if (totalSalesCount <= 0) return 0
  return roundStatsAmount(totalAmount / totalSalesCount)
}

const parseCustomDate = (value: string, timezone: string): Date => {
  const parsed = toDate(value, { timeZone: timezone })
  return parsed
}

export const resolveStatsDateRange = (
  period: StatsPeriod,
  timezone: string,
  options?: Pick<SaleStatsRequest, 'from' | 'to'> & { now?: Date }
): StatsValidationResult<StatsDateRange> => {
  const referenceDate = options?.now ?? new Date()

  if (period === STATS_PERIOD.CUSTOM) {
    const hasFrom = options?.from !== undefined && options.from !== ''
    const hasTo = options?.to !== undefined && options.to !== ''

    if (!hasFrom || !hasTo) {
      return buildValidationError(
        STATS_VALIDATION_ERROR.CUSTOM_RANGE_REQUIRED,
        'Custom period requires both from and to.',
        !hasFrom ? 'from' : 'to'
      )
    }

    const fromValue = options.from as string
    const toValue = options.to as string

    const from = parseCustomDate(fromValue, timezone)
    if (Number.isNaN(from.getTime())) {
      return buildValidationError(STATS_VALIDATION_ERROR.INVALID_FROM_DATE, 'Invalid from date.', 'from')
    }

    const to = parseCustomDate(toValue, timezone)
    if (Number.isNaN(to.getTime())) {
      return buildValidationError(STATS_VALIDATION_ERROR.INVALID_TO_DATE, 'Invalid to date.', 'to')
    }

    if (from.getTime() > to.getTime()) {
      return buildValidationError(STATS_VALIDATION_ERROR.INVALID_DATE_RANGE, 'From date must be before or equal to to date.')
    }

    return buildValidationSuccess({
      from,
      to,
      fromIso: from.toISOString(),
      toIso: to.toISOString()
    })
  }

  const zonedNow = toZonedTime(referenceDate, timezone)

  let zonedFrom: Date
  let zonedTo: Date

  switch (period) {
    case STATS_PERIOD.DAY:
      zonedFrom = startOfDay(zonedNow)
      zonedTo = endOfDay(zonedNow)
      break
    case STATS_PERIOD.WEEK:
      zonedFrom = startOfWeek(zonedNow, { weekStartsOn: 1 })
      zonedTo = endOfWeek(zonedNow, { weekStartsOn: 1 })
      break
    case STATS_PERIOD.MONTH:
      zonedFrom = startOfMonth(zonedNow)
      zonedTo = endOfMonth(zonedNow)
      break
    case STATS_PERIOD.YEAR:
      zonedFrom = startOfYear(zonedNow)
      zonedTo = endOfYear(zonedNow)
      break
    default:
      return buildValidationError(STATS_VALIDATION_ERROR.INVALID_PERIOD, 'Invalid stats period.', 'period')
  }

  const from = fromZonedTime(zonedFrom, timezone)
  const to = fromZonedTime(zonedTo, timezone)

  return buildValidationSuccess({
    from,
    to,
    fromIso: from.toISOString(),
    toIso: to.toISOString()
  })
}

export const parseSaleStatsRequest = (input: unknown, options?: ParseSaleStatsRequestOptions): StatsValidationResult<ResolvedStatsRequest> => {
  if (!isRecord(input)) {
    return buildValidationError(STATS_VALIDATION_ERROR.INVALID_REQUEST_BODY, 'Request body must be an object.')
  }

  const periodValue = input.period
  if (typeof periodValue !== 'string' || !isStatsPeriod(periodValue)) {
    return buildValidationError(STATS_VALIDATION_ERROR.INVALID_PERIOD, 'Period must be one of day, week, month, year or custom.', 'period')
  }

  const timezoneValue = input.timezone
  const timezone = typeof timezoneValue === 'string' && timezoneValue.trim() !== ''
    ? timezoneValue.trim()
    : DEFAULT_STATS_TIMEZONE

  if (!isValidStatsTimezone(timezone)) {
    return buildValidationError(STATS_VALIDATION_ERROR.INVALID_TIMEZONE, 'Timezone must be a valid IANA timezone.', 'timezone')
  }

  const includeCancelledValue = input.includeCancelled
  if (includeCancelledValue !== undefined && typeof includeCancelledValue !== 'boolean') {
    return buildValidationError(STATS_VALIDATION_ERROR.INVALID_INCLUDE_CANCELLED, 'includeCancelled must be a boolean.', 'includeCancelled')
  }

  const allowUserId = options?.allowUserId ?? true
  const scope = options?.scope ?? (allowUserId ? STATS_SCOPE.BY_USER : STATS_SCOPE.OVERVIEW)
  const userIdValue = input.userId

  if (!allowUserId && userIdValue !== undefined) {
    return buildValidationError(STATS_VALIDATION_ERROR.USER_ID_NOT_ALLOWED, 'userId is not allowed for overview stats.', 'userId')
  }

  let userId: string | undefined
  let userObjectId: Types.ObjectId | undefined

  if (userIdValue !== undefined) {
    if (typeof userIdValue !== 'string' || !Types.ObjectId.isValid(userIdValue)) {
      return buildValidationError(STATS_VALIDATION_ERROR.INVALID_USER_ID, 'userId must be a valid Mongo ObjectId.', 'userId')
    }

    userId = userIdValue
    userObjectId = new Types.ObjectId(userIdValue)
  }

  const dateRangeResult = resolveStatsDateRange(periodValue, timezone, {
    from: typeof input.from === 'string' ? input.from : undefined,
    to: typeof input.to === 'string' ? input.to : undefined,
    now: options?.now
  })

  if (!dateRangeResult.ok) {
    return dateRangeResult
  }

  return buildValidationSuccess({
    period: periodValue,
    timezone,
    includeCancelled: includeCancelledValue ?? false,
    from: dateRangeResult.value.from,
    to: dateRangeResult.value.to,
    fromIso: dateRangeResult.value.fromIso,
    toIso: dateRangeResult.value.toIso,
    generatedAt: options?.now ?? new Date(),
    scope,
    userId,
    userObjectId
  })
}

export { DEFAULT_STATS_TIMEZONE }
