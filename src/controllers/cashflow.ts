/**
 * CashflowController — TICKET-004: cash-flow-real-v1
 *
 * Handlers for all /cashflow routes.
 * Auth (checkJwt + checkPermission) is enforced in the route layer.
 *
 * Design constraints (design.md):
 *  - No /api prefix; auto-loaded by src/routes/index.ts
 *  - Same checkJwt + checkPermission pattern as expense.ts, buy.ts, etc.
 *  - 400 returned if startDate / endDate are missing on data endpoints
 *  - 400 returned if openingBalance is missing / non-numeric on updateConfig
 */

import { Request, Response } from 'express'
import { JwtPayload } from 'jsonwebtoken'
import { handleHttp } from '../utils/error.handle'
import cashflowService from '../services/cashflow'

interface RequestExt extends Request {
  user?: string | JwtPayload | undefined | any
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Validates that startDate and endDate are present query params.
 * Returns { startDate, endDate } as Date objects on success, or calls
 * res.status(400).json and returns null on failure.
 */
function parseDateRange (
  query: Record<string, any>,
  res: Response
): { startDate: Date; endDate: Date } | null {
  const { startDate: s, endDate: e } = query
  if (!s || !e) {
    res.status(400).json({ error: 'startDate and endDate query params are required' })
    return null
  }
  const startDate = new Date(s as string)
  const endDate = new Date(e as string)
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    res.status(400).json({ error: 'startDate and endDate must be valid ISO date strings' })
    return null
  }
  return { startDate, endDate }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/**
 * GET /cashflow/summary?startDate=&endDate=
 * Returns CashflowSummary for the given period.
 */
export const getSummary = async ({ query }: RequestExt, res: Response): Promise<void> => {
  try {
    const dates = parseDateRange(query as Record<string, any>, res)
    if (!dates) return

    const summary = await cashflowService.computeSummary(dates.startDate, dates.endDate)
    res.json({ summary })
  } catch (error: any) {
    handleHttp(res, 'ERROR_GET_CASHFLOW_SUMMARY', error)
  }
}

/**
 * GET /cashflow/timeline?startDate=&endDate=
 * Returns CashflowMovement[] ordered by cashDate ascending.
 */
export const getTimeline = async ({ query }: RequestExt, res: Response): Promise<void> => {
  try {
    const dates = parseDateRange(query as Record<string, any>, res)
    if (!dates) return

    const movements = await cashflowService.computeMovements(dates.startDate, dates.endDate)
    // Sort ascending by cashDate (spec: "entries ordered by cash date ascending")
    const timeline = [...movements].sort((a, b) => a.date.getTime() - b.date.getTime())
    res.json({ timeline })
  } catch (error: any) {
    handleHttp(res, 'ERROR_GET_CASHFLOW_TIMELINE', error)
  }
}

/**
 * GET /cashflow/movements?startDate=&endDate=
 * Returns the same movement list as timeline but as a flat array for
 * table rendering (no sorting requirement imposed — same data, no grouping).
 */
export const getMovements = async ({ query }: RequestExt, res: Response): Promise<void> => {
  try {
    const dates = parseDateRange(query as Record<string, any>, res)
    if (!dates) return

    const movements = await cashflowService.computeMovements(dates.startDate, dates.endDate)
    res.json({ movements })
  } catch (error: any) {
    handleHttp(res, 'ERROR_GET_CASHFLOW_MOVEMENTS', error)
  }
}

/**
 * GET /cashflow/config
 * Returns the CashflowConfig singleton (creates with openingBalance = 0 if absent).
 */
export const getConfig = async (_req: RequestExt, res: Response): Promise<void> => {
  try {
    const config = await cashflowService.getOrCreateConfig()
    res.json({ config })
  } catch (error: any) {
    handleHttp(res, 'ERROR_GET_CASHFLOW_CONFIG', error)
  }
}

/**
 * PUT /cashflow/config
 * Updates the CashflowConfig singleton's openingBalance.
 * Requires configure_cashflow permission (enforced in route layer).
 */
export const updateConfig = async ({ body }: RequestExt, res: Response): Promise<void> => {
  try {
    const { openingBalance } = body
    if (openingBalance === undefined || openingBalance === null) {
      res.status(400).json({ error: 'openingBalance is required' })
      return
    }
    if (typeof openingBalance !== 'number' || isNaN(openingBalance)) {
      res.status(400).json({ error: 'openingBalance must be a number' })
      return
    }
    const config = await cashflowService.updateConfig(openingBalance)
    res.json({ config })
  } catch (error: any) {
    handleHttp(res, 'ERROR_UPDATE_CASHFLOW_CONFIG', error)
  }
}
