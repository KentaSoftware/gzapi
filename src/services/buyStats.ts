import BuyModel from '../models/buy'
import {
  calculateAverageTicket,
  roundStatsAmount
} from '../utils/statsDateRange'
import type {
  ResolvedStatsRequest,
  SaleStatsByUserAggregationRow,
  SaleStatsSummary,
  SaleStatsSummaryAggregationRow
} from '../interfaces/saleStats.interface'
import type {
  BuyStatsByUserResponse,
  BuyStatsOverviewResponse
} from '../interfaces/buyStats.interface'

const DELETED_USER_NICKNAME = 'Usuario eliminado'

interface BuyStatsFacetAggregationRow {
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

interface BuyStatsOverviewAggregationRow {
  _id: null
  totalBuysCount: number
  totalAmount: number
  activeProviderIds: unknown[]
}

/**
 * Builds a MongoDB $match stage for BuyModel aggregation pipelines.
 *
 * Unlike saleStats, this does NOT include a cancellation ($expr/estado)
 * filter — BuyModel has no "Cancelado" concept, and all buys are counted
 * regardless of estado value (REQ buy-stats-api#3).
 */
export const buildBuyStatsMatch = (input: ResolvedStatsRequest): Record<string, unknown> => {
  const match: Record<string, unknown> = {
    createdAt: {
      $gte: input.from,
      $lte: input.to
    }
  }

  if (input.userObjectId !== undefined) {
    match.user = input.userObjectId
  }

  return match
}

export const buildEmptySummary = (input: ResolvedStatsRequest): SaleStatsSummary => {
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

export const buildSummary = (
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

const mapByUserItems = (rows: BuyStatsFacetAggregationRow['items']): SaleStatsByUserAggregationRow[] => {
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
  facetSummary: BuyStatsFacetAggregationRow['summary'][number] | undefined,
  input: ResolvedStatsRequest
): SaleStatsSummary => {
  if (facetSummary === undefined) {
    return buildEmptySummary(input)
  }

  return buildSummary({
    totalSalesCount: facetSummary.totalSalesCount,
    totalAmount: facetSummary.totalAmount,
    activeSellersCount: facetSummary.activeUserIds.length
  }, input)
}

export const getBuyStatsByUser = async (input: ResolvedStatsRequest): Promise<BuyStatsByUserResponse> => {
  const match = buildBuyStatsMatch(input)

  const [result] = await BuyModel.aggregate<BuyStatsFacetAggregationRow>([
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

export const getBuyStatsOverview = async (input: ResolvedStatsRequest): Promise<BuyStatsOverviewResponse> => {
  const match = buildBuyStatsMatch(input)

  const [result] = await BuyModel.aggregate<BuyStatsOverviewAggregationRow>([
    {
      $match: match
    },
    {
      $group: {
        _id: null,
        totalBuysCount: {
          $sum: 1
        },
        totalAmount: {
          $sum: '$total'
        },
        activeProviderIds: {
          $addToSet: '$proveedor'
        }
      }
    }
  ])

  return {
    summary: buildSummary(result === undefined
      ? undefined
      : {
          totalSalesCount: result.totalBuysCount,
          totalAmount: result.totalAmount,
          activeSellersCount: result.activeProviderIds.length
        }, input)
  }
}
