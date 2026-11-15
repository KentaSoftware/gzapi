import type { RouteSnapshotSaleReference } from '../interfaces/routeOptimization.interface'

const normalizeSaleReference = (reference: RouteSnapshotSaleReference): RouteSnapshotSaleReference => {
  const { address, ...rest } = reference
  return typeof address === 'string' && address.trim() !== '' ? { ...rest, address } : rest
}

export { normalizeSaleReference }
