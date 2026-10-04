// Phase 0 feature flag. Read at request time (not import time) so tests and
// future per-request toggling observe the current value of the environment.
const isPhase0ContractsEnabled = (): boolean => process.env.PHASE_0_CONTRACTS_ENABLED === 'true'
const isRouteOptimizationEnabled = (): boolean => process.env.ROUTE_OPTIMIZATION_ENABLED === 'true'

export { isPhase0ContractsEnabled, isRouteOptimizationEnabled }
