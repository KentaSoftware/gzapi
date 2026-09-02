import SaleModel from '../models/sale'
import {
  calculateAverageTicket,
  normalizeCancelledState,
  roundStatsAmount
} from '../utils/statsDateRange'
import type {
  ResolvedStatsRequest,
  SaleStatsByUserAggregationRow,
  SaleStatsByUserResponse,
  SaleStatsOverviewResponse,
  SaleStatsSummary,
  SaleStatsSummaryAggregationRow
} from '../interfaces/saleStats.interface'

const DELETED_USER_NICKNAME = 'Usuario eliminado'

interface SaleStatsFacetAggregationRow {
  items: Array<{
    _id: unknown
    nickname: string
    salesCount: number
    totalAmount: number
  }>
  summary: Array<{
    totalSalesCount: number
    totalAmount: number
    activeUserIds: unknown[]
  }>
}

interface SaleStatsOverviewAggregationRow {
  _id: null
  totalSalesCount: number
  totalAmount: number
  activeUserIds: unknown[]
}

const buildSaleStatsMatch = (input: ResolvedStatsRequest): Record<string, unknown> => {
  const match: Record<string, unknown> = {
    createdAt: {
      $gte: input.from,
      $lte: input.to
    }
  }

  if (input.userObjectId !== undefined) {
    match.user = input.userObjectId
  }

  if (!input.includeCancelled) {
    match.$expr = {
      $ne: [
        {
          $toLower: {
            $trim: {
              input: {
                $ifNull: ['$estado', '']
              }
            }
          }
        },
        normalizeCancelledState('Cancelado')
      ]
    }
  }

  return match
}

const buildEmptySummary = (input: ResolvedStatsRequest): SaleStatsSummary => {
  return {
    totalSalesCount: 0,
    totalAmount: 0,
    activeSellersCount: 0,
    averageTicket: 0,
    from: input.fromIso,
    to: input.toIso,
    generatedAt: input.generatedAt.toISOString()
  }
}

const buildSummary = (
  row: SaleStatsSummaryAggregationRow | undefined,
  input: ResolvedStatsRequest
): SaleStatsSummary => {
  if (row === undefined) {
    return buildEmptySummary(input)
  }

  const totalAmount = roundStatsAmount(row.totalAmount)

  return {
    totalSalesCount: row.totalSalesCount,
    totalAmount,
    activeSellersCount: row.activeSellersCount,
    averageTicket: calculateAverageTicket(totalAmount, row.totalSalesCount),
    from: input.fromIso,
    to: input.toIso,
    generatedAt: input.generatedAt.toISOString()
  }
}

const mapByUserItems = (rows: SaleStatsFacetAggregationRow['items']): SaleStatsByUserAggregationRow[] => {
  return rows.map((row) => {
    const totalAmount = roundStatsAmount(row.totalAmount)

    return {
      userId: String(row._id),
      nickname: row.nickname,
      roleName: null,
      salesCount: row.salesCount,
      totalAmount,
      averageTicket: calculateAverageTicket(totalAmount, row.salesCount)
    }
  })
}

const buildByUserSummary = (
  row: SaleStatsFacetAggregationRow['summary'][number] | undefined,
  input: ResolvedStatsRequest
): SaleStatsSummary => {
  if (row === undefined) {
    return buildEmptySummary(input)
  }

  return buildSummary({
    totalSalesCount: row.totalSalesCount,
    totalAmount: row.totalAmount,
    activeSellersCount: row.activeUserIds.length
  }, input)
}

const getSaleStatsByUser = async (input: ResolvedStatsRequest): Promise<SaleStatsByUserResponse> => {
  const match = buildSaleStatsMatch(input)

  const [result] = await SaleModel.aggregate<SaleStatsFacetAggregationRow>([
    {
      $match: match
    },
    {
      $facet: {
        items: [
          {
            $lookup: {
              from: 'users',
              localField: 'user',
              foreignField: '_id',
              as: 'userDoc'
            }
          },
          {
            $unwind: {
              path: '$userDoc',
              preserveNullAndEmptyArrays: true
            }
          },
          {
            $group: {
              _id: '$user',
              nickname: {
                $first: {
                  $ifNull: ['$userDoc.nickname', DELETED_USER_NICKNAME]
                }
              },
              salesCount: {
                $sum: 1
              },
              totalAmount: {
                $sum: '$total'
              }
            }
          },
          {
            $sort: {
              totalAmount: -1,
              salesCount: -1,
              nickname: 1,
              _id: 1
            }
          }
        ],
        summary: [
          {
            $group: {
              _id: null,
              totalSalesCount: {
                $sum: 1
              },
              totalAmount: {
                $sum: '$total'
              },
              activeUserIds: {
                $addToSet: '$user'
              }
            }
          },
          {
            $project: {
              _id: 0,
              totalSalesCount: 1,
              totalAmount: 1,
              activeUserIds: 1
            }
          }
        ]
      }
    }
  ])

  return {
    summary: buildByUserSummary(result?.summary[0], input),
    items: mapByUserItems(result?.items ?? [])
  }
}

const getSaleStatsOverview = async (input: ResolvedStatsRequest): Promise<SaleStatsOverviewResponse> => {
  const match = buildSaleStatsMatch(input)

  const [result] = await SaleModel.aggregate<SaleStatsOverviewAggregationRow>([
    {
      $match: match
    },
    {
      $group: {
        _id: null,
        totalSalesCount: {
          $sum: 1
        },
        totalAmount: {
          $sum: '$total'
        },
        activeUserIds: {
          $addToSet: '$user'
        }
      }
    }
  ])

  return {
    summary: buildSummary(result === undefined
      ? undefined
      : {
          totalSalesCount: result.totalSalesCount,
          totalAmount: result.totalAmount,
          activeSellersCount: result.activeUserIds.length
        }, input)
  }
}

export { getSaleStatsByUser, getSaleStatsOverview }
