import { normalizeText } from './normalize'

/**
 * Similarity helpers for catalog matching (PS-T10).
 * Pure functions, no external dependencies.
 */

const FUZZY_THRESHOLD = 0.55

const sanitize = (value: string): string =>
  normalizeText(value)
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const tokenize = (value: string): string[] => sanitize(value).split(' ').filter(token => token.length > 0)

/** Levenshtein distance with two rolling rows (O(n*m) time, O(m) space). */
export const levenshtein = (a: string, b: string): number => {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  let previous = new Array<number>(b.length + 1)
  let current = new Array<number>(b.length + 1)

  for (let j = 0; j <= b.length; j += 1) previous[j] = j

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost)
    }
    const swap = previous
    previous = current
    current = swap
  }

  return previous[b.length]
}

/** 1 when the strings are identical, 0 when completely different. */
export const similarity = (a: string, b: string): number => {
  if (a === b) return 1
  const longest = Math.max(a.length, b.length)
  if (longest === 0) return 1
  return 1 - levenshtein(a, b) / longest
}

const bestTokenMatch = (queryToken: string, candidateTokens: string[]): number => {
  let best = 0
  for (const candidateToken of candidateTokens) {
    const score = similarity(queryToken, candidateToken)
    if (score > best) best = score
  }
  return best
}

/**
 * Score between 0 and 1 for a free-text query against a product description.
 * Tolerates OCR mistakes: each query token is compared against the closest
 * candidate token, then combined with the whole-string similarity.
 */
export const fuzzyScore = (query: string, candidate: string): number => {
  const queryTokens = tokenize(query)
  const candidateTokens = tokenize(candidate)

  if (queryTokens.length === 0 || candidateTokens.length === 0) return 0

  const tokenCoverage =
    queryTokens.reduce((total, token) => total + bestTokenMatch(token, candidateTokens), 0) /
    queryTokens.length

  const wholeSimilarity = similarity(sanitize(query), sanitize(candidate))

  const score = tokenCoverage * 0.8 + wholeSimilarity * 0.2
  return Math.round(score * 100) / 100
}

export const isFuzzyCandidate = (query: string, candidate: string): boolean =>
  fuzzyScore(query, candidate) >= FUZZY_THRESHOLD

export const FUZZY_MIN_SCORE = FUZZY_THRESHOLD

/** Query tokens used to build a bounded candidate fetch (ignores very short noise). */
export const extractSearchTokens = (query: string, maxTokens = 4): string[] =>
  tokenize(query)
    .filter(token => token.length >= 3)
    .slice(0, maxTokens)
