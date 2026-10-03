import type { SaleStatsSummary, SaleStatsByUserItem } from './saleStats.interface'

export type BuyStatsSummary = SaleStatsSummary
export type BuyStatsByUserItem = SaleStatsByUserItem
export interface BuyStatsByUserResponse { summary: BuyStatsSummary, items: BuyStatsByUserItem[] }
export interface BuyStatsOverviewResponse { summary: BuyStatsSummary }

export { STATS_PERIOD, STATS_SCOPE } from './saleStats.interface'
