/**
 * FinanceController — /finance dashboard, rules (CU-012), PDF export.
 * Auth: checkJwt + read_cashflow (fine-grained RBAC deferred).
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
  if (typeof e === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e)) {
    endDate.setUTCHours(23, 59, 59, 999)
  }
  return { startDate, endDate }
}

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

export const updateRules = async ({ body }: RequestExt, res: Response): Promise<void> => {
  try {
    const patch: Record<string, unknown> = {}
    if (body.reserveMinimumAmount !== undefined) patch.reserveMinimumAmount = Number(body.reserveMinimumAmount)
    if (body.deficitAlertThresholdPercent !== undefined) {
      patch.deficitAlertThresholdPercent = Number(body.deficitAlertThresholdPercent)
    }
    if (body.minExpectedRoiPercent !== undefined) {
      patch.minExpectedRoiPercent = Number(body.minExpectedRoiPercent)
    }
    if (body.historyEvaluationDays !== undefined) {
      patch.historyEvaluationDays = Number(body.historyEvaluationDays)
    }
    if (body.riskProfile !== undefined) patch.riskProfile = body.riskProfile
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

export const exportReportPdf = async ({ query }: RequestExt, res: Response): Promise<void> => {
  try {
    const dates = parseDateRange(query as Record<string, any>, res)
    if (dates == null) return

    const dashboard = await financeService.getDashboard(dates.startDate, dates.endDate)
    const doc = new PDFDocument({ margin: 50, size: 'A4' })

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="golozur360-finance-${dashboard.startDate.slice(0, 10)}.pdf"`
    )
    doc.pipe(res)

    doc.fontSize(18).text('Golozur360 — Reporte Financiero', { align: 'left' })
    doc.moveDown(0.5)
    doc.fontSize(10).fillColor('#444')
      .text(`Generado: ${new Date(dashboard.generatedAt).toLocaleString('es-AR')}`)
      .text(`Versión de reglas: ${dashboard.rulesVersion}`)
      .text(`Moneda: ${dashboard.currency}`)
    doc.moveDown()

    doc.fillColor('#000').fontSize(14).text('1. Resumen del período', { underline: true })
    doc.moveDown(0.3)
    doc.fontSize(11)
    doc.text(`Desde: ${dashboard.startDate.slice(0, 10)}  Hasta: ${dashboard.endDate.slice(0, 10)}`)
    if (dashboard.emptyPeriod) {
      doc.text('No se encontraron registros para las fechas seleccionadas.')
    }
    const k = dashboard.kpis
    doc.text(`Saldo actual: ARS ${k.currentBalance.toFixed(2)}`)
    doc.text(`Ingresos: ARS ${k.totalInflows.toFixed(2)}`)
    doc.text(`Egresos: ARS ${k.totalOutflows.toFixed(2)}`)
    doc.text(`Flujo neto: ARS ${k.netCashFlow.toFixed(2)}`)
    doc.text(`Capital ocioso: ARS ${k.idleCapital.toFixed(2)}`)
    doc.text(`Reserva efectiva: ARS ${k.effectiveReserve.toFixed(2)}`)
    doc.moveDown()

    doc.fontSize(14).text('2. Proyección semanal (real vs proyectado)', { underline: true })
    doc.moveDown(0.3)
    doc.fontSize(11)
    if (dashboard.weeklyProjection.length === 0) {
      doc.text('Sin semanas en el período.')
    } else {
      for (const w of dashboard.weeklyProjection) {
        doc.text(
          `${w.label}: real ARS ${w.realNet.toFixed(2)} / proyectado ARS ${w.projectedNet.toFixed(2)}`
        )
      }
    }
    doc.moveDown()

    doc.fontSize(14).text('3. Oportunidad / alertas', { underline: true })
    doc.moveDown(0.3)
    doc.fontSize(11)
    doc.text(`${dashboard.opportunity.title}`)
    doc.text(`  ${dashboard.opportunity.explanation}`)
    doc.moveDown(0.3)
    if (dashboard.insights.length === 0) {
      doc.text('Sin alertas adicionales.')
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
