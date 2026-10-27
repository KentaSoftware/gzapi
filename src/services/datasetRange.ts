/**
 * PS-T28 — Rango de fechas de reportes alineado con el flujo de caja.
 *
 * `cashflow` fecha cada movimiento con la cadena
 * `paidAt ?? fecha ?? date ?? createdAt` (PS-T24/PS-T25). El dashboard usaba
 * solo `createdAt`, así que una compra cargada hoy con fecha de comprobante de
 * enero aparecía en el día de hoy y no coincidía con el Flujo de Caja.
 */

/** Fecha efectiva de un documento, con la misma prioridad que `resolveCashDate`. */
export const CASH_DATE_EXPR = {
  $ifNull: ['$paidAt', { $ifNull: ['$fecha', { $ifNull: ['$date', '$createdAt'] }] }]
} as const;

/**
 * Filtro de rango inclusivo sobre la fecha efectiva. Se esparce dentro de un
 * `$match` para conservar los demás criterios del reporte.
 */
export const cashDateBetween = (from: Date, to: Date) => ({
  $expr: {
    $and: [
      { $gte: [CASH_DATE_EXPR, from] },
      { $lte: [CASH_DATE_EXPR, to] }
    ]
  }
});
