const DEFAULT_STOCK_TIME_ZONE = 'America/Argentina/Buenos_Aires'
const DEFAULT_STOCK_EXPIRY_ALERT_DAYS = 14
const DEFAULT_STOCK_ROTATION_DAYS = 90
const DEFAULT_STOCK_RULES_VERSION = 'stock-rules-v1'

const parseBoundedInteger = (name: string, fallback: number, minimum: number, maximum: number): number => {
  const rawValue = process.env[name]
  if (rawValue === undefined || rawValue.trim() === '') return fallback

  if (!/^\d+$/.test(rawValue.trim())) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }

  const value = Number(rawValue)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }

  return value
}

const parseTimeZone = (): string => {
  const rawValue = process.env.STOCK_TIME_ZONE
  const value = rawValue === undefined || rawValue.trim() === '' ? DEFAULT_STOCK_TIME_ZONE : rawValue.trim()
  if (value.length > 64 || /\s/.test(value)) {
    throw new Error('STOCK_TIME_ZONE must be a valid IANA time zone')
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
  } catch {
    throw new Error('STOCK_TIME_ZONE must be a valid IANA time zone')
  }

  return value
}

const parseRulesVersion = (): string => {
  const rawValue = process.env.STOCK_RULES_VERSION
  const value = rawValue === undefined || rawValue.trim() === '' ? DEFAULT_STOCK_RULES_VERSION : rawValue.trim()
  if (value.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error('STOCK_RULES_VERSION must be a bounded identifier')
  }
  return value
}

const STOCK_TIME_ZONE = parseTimeZone()
const STOCK_EXPIRY_ALERT_DAYS = parseBoundedInteger('STOCK_EXPIRY_ALERT_DAYS', DEFAULT_STOCK_EXPIRY_ALERT_DAYS, 0, 3650)
const STOCK_ROTATION_DAYS = parseBoundedInteger('STOCK_ROTATION_DAYS', DEFAULT_STOCK_ROTATION_DAYS, 1, 3650)
const STOCK_RULES_VERSION = parseRulesVersion()

export {
  STOCK_TIME_ZONE,
  STOCK_EXPIRY_ALERT_DAYS,
  STOCK_ROTATION_DAYS,
  STOCK_RULES_VERSION
}
