/**
 * FinanceController — /finance dashboard, rules (CU-012), PDF export.
 * Auth: checkJwt + read_cashflow (Spec §7.6 — fine-grained RBAC deferred).
 */

import { Request, Response } from 'express'
import { JwtPayload } from 'jsonwebtoken'
import PDFDocument from 'pdfkit'
import { handleHttp } from '../utils/error.handle'
import financeService from '../services/finance'
import { DISCLAIMER_NO_ADVICE } from '../services/financeRules'
import { FINANCE_RULES_VERSION } from '../interfaces/finance.interface'

interface RequestExt extends Request {
  user?: string | JwtPayload | undefined | any
}

function parseDateRange (
  query: Record<string, any>,
  res: Response
): { startDate: Date, endDate: Date } | null {
  const { startDate: s, endDate: e } = query
  if (s == null || s === '' || e == null || e === '') {
    res.status(400).json({
      error: 'startDate and endDate query params are required',
      code: 'FINANCE_INVALID_PERIOD'
    })
    return null
  }
  const startDate = new Date(s as string)
  const endDate = new Date(e as string)
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    res.status(400).json({
      error: 'startDate and endDate must be valid ISO date strings',
      code: 'FINANCE_INVALID_PERIOD'
    })
    return null
  }
  if (startDate.getTime() > endDate.getTime()) {
    res.status(400).json({
      error: 'startDate must be less than or equal to endDate',
      code: 'FINANCE_INVALID_PERIOD'
    })
    return null
  }
  // Inclusive end-of-day if date-only string (YYYY-MM-DD)
  if (typeof e === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e)) {
    endDate.setUTCHours(23, 59, 59, 999)
  }
  return { startDate, endDate }
}

/**
 * GET /finance/dashboard?startDate=&endDate=
 */
export const getDashboard = async ({ query }: RequestExt, res: Response): Promise<void> => {
  try {
    const dates = parseDateRange(query as Record<string, any>, res)
    if (dates == null) return
    const dashboard = await financeService.getDashboard(dates.startDate, dates.endDate)
    res.json({ dashboard })
  } catch (error: any) {
    if (error?.code === 'FINANCE_INVALID_PERIOD' || error?.status === 400) {
      res.status(400).json({ error: error.message, code: error.code ?? 'FINANCE_INVALID_PERIOD' })
      return
    }
    handleHttp(res, 'ERROR_GET_FINANCE_DASHBOARD', error)
  }
}

/**
 * GET /finance/rules
 */
export const getRules = async (_req: RequestExt, res: Response): Promise<void> => {
  try {
    const config = await financeService.getRulesConfig()
    res.json({
      rulesVersion: FINANCE_RULES_VERSION,
      config,
      disclaimer: DISCLAIMER_NO_ADVICE
    })
  } catch (error: any) {
    handleHttp(res, 'ERROR_GET_FINANCE_RULES', error)
  }
}

/**
 * PUT /finance/rules — CU-012 (no fine-grained permission split in this iteration).
 */
export const updateRules = async ({ body }: RequestExt, res: Response): Promise<void> => {
  try {
    const patch: Record<string, unknown> = {}
    if (body.openingBalance !== undefined) patch.openingBalance = Number(body.openingBalance)
    if (body.reserveMonthsMultiplier !== undefined) {
      patch.reserveMonthsMultiplier = Number(body.reserveMonthsMultiplier)
    }
    if (body.deficitAlertEnabled !== undefined) {
      patch.deficitAlertEnabled = Boolean(body.deficitAlertEnabled)
    }
    if (body.idleCapitalRecommendMin !== undefined) {
      patch.idleCapitalRecommendMin = Number(body.idleCapitalRecommendMin)
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'At least one rule field is required' })
      return
    }
    const config = await financeService.updateRulesConfig(patch as any)
    res.json({
      rulesVersion: FINANCE_RULES_VERSION,
      config,
      disclaimer: DISCLAIMER_NO_ADVICE
    })
  } catch (error: any) {
    if (error?.status === 400) {
      res.status(400).json({ error: error.message })
      return
    }
    handleHttp(res, 'ERROR_UPDATE_FINANCE_RULES', error)
  }
}

/**
 * GET /finance/report.pdf?startDate=&endDate=
 */
export const exportReportPdf = async ({ query }: RequestExt, res: Response): Promise<void> => {
  try {
    const dates = parseDateRange(query as Record<string, any>, res)
    if (dates == null) return

    const dashboard = await financeService.getDashboard(dates.startDate, dates.endDate)
    const doc = new PDFDocument({ margin: 50, size: 'A4' })

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="golozur360-finance-${dashboard.historical.startDate.slice(0, 10)}.pdf"`
    )
    doc.pipe(res)

    doc.fontSize(18).text('Golozur360 — Reporte Financiero', { align: 'left' })
    doc.moveDown(0.5)
    doc.fontSize(10).fillColor('#444')
      .text(`Generado: ${new Date(dashboard.generatedAt).toLocaleString('es-AR')}`)
      .text(`Versión de reglas: ${dashboard.rulesVersion}`)
      .text(`Moneda: ${dashboard.currency}`)
    doc.moveDown()

    doc.fillColor('#000').fontSize(14).text('1. Histórico del período', { underline: true })
    doc.moveDown(0.3)
    doc.fontSize(11)
    const h = dashboard.historical
    doc.text(`Desde: ${h.startDate.slice(0, 10)}  Hasta: ${h.endDate.slice(0, 10)}`)
    doc.text(`Saldo inicial: ARS ${h.openingBalance.toFixed(2)}`)
    doc.text(`Ingresos: ARS ${h.totalInflows.toFixed(2)}`)
    doc.text(`Egresos: ARS ${h.totalOutflows.toFixed(2)}`)
    doc.text(`Flujo neto: ARS ${h.netCashFlow.toFixed(2)}`)
    doc.text(`Saldo final: ARS ${h.closingBalance.toFixed(2)}`)
    doc.moveDown()

    doc.fontSize(14).text('2. Proyección', { underline: true })
    doc.moveDown(0.3)
    doc.fontSize(11)
    const p = dashboard.projection
    if (p.status !== 'ok') {
      doc.text(`Estado: ${p.status}`)
      if (p.message) doc.text(p.message)
    } else {
      doc.text(`Período proyectado: ${p.periodLabel}`)
      doc.text(`Ingresos proyectados: ARS ${p.projectedInflows.toFixed(2)}`)
      doc.text(`Egresos proyectados: ARS ${p.projectedOutflows.toFixed(2)}`)
      doc.text(`Saldo final proyectado: ARS ${p.projectedClosingBalance.toFixed(2)}`)
      doc.text(`Reserva mínima: ARS ${p.reserveMinimum.toFixed(2)}`)
      doc.text(`Capital ocioso: ARS ${p.idleCapital.toFixed(2)}`)
      doc.text(`Clasificación: ${p.liquidityClass ?? 'n/d'}`)
      if (p.comparableMonths.length > 0) {
        doc.moveDown(0.3)
        doc.text('Meses comparables:')
        for (const m of p.comparableMonths) {
          doc.text(
            `  ${m.label}: ingresos ${m.inflows.toFixed(2)} / egresos ${m.outflows.toFixed(2)}`
          )
        }
      }
    }
    doc.moveDown()

    doc.fontSize(14).text('3. Alertas y recomendaciones', { underline: true })
    doc.moveDown(0.3)
    doc.fontSize(11)
    if (dashboard.insights.length === 0) {
      doc.text('Sin alertas ni recomendaciones para este período.')
    } else {
      for (const insight of dashboard.insights) {
        doc.text(`[${insight.type}/${insight.severity}] ${insight.title}`)
        doc.text(`  ${insight.explanation}`)
        if (insight.disclaimer) doc.text(`  ${insight.disclaimer}`)
        doc.moveDown(0.3)
      }
    }
    doc.moveDown()

    doc.fontSize(9).fillColor('#666').text(DISCLAIMER_NO_ADVICE, { align: 'left' })
    doc.end()
  } catch (error: any) {
    if (!res.headersSent) {
      handleHttp(res, 'ERROR_EXPORT_FINANCE_PDF', error)
    }
  }
}
