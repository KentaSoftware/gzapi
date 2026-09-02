import type { SaleStatsSummary, SaleStatsByUserItem } from './saleStats.interface'

export type BuyStatsSummary = SaleStatsSummary
export type BuyStatsByUserItem = SaleStatsByUserItem
export type BuyStatsByUserResponse = { summary: BuyStatsSummary; items: BuyStatsByUserItem[] }
export type BuyStatsOverviewResponse = { summary: BuyStatsSummary }

export { STATS_PERIOD, STATS_SCOPE } from './saleStats.interface'
