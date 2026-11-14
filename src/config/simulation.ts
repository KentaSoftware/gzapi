const CONTRACT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const parseContractAllowlist = (rawValue: string | undefined): readonly string[] => {
  if (rawValue === undefined || rawValue.trim() === '') return Object.freeze([])
  const versions = rawValue.split(',').map((entry) => entry.trim())
  if (versions.some((entry) => !CONTRACT_VERSION_PATTERN.test(entry))) {
    throw new Error('Simulation contract allowlists must contain bounded contract version identifiers')
  }
  if (new Set(versions).size !== versions.length) {
    throw new Error('Simulation contract allowlists must not contain duplicate versions')
  }
  return Object.freeze([...versions])
}

interface SimulationConfiguration {
  routeContractAllowlist: readonly string[]
  stockContractAllowlist: readonly string[]
}

const readSimulationConfig = (env: Record<string, string | undefined>): SimulationConfiguration => Object.freeze({
  routeContractAllowlist: parseContractAllowlist(env.SIMULATION_ROUTE_CONTRACT_ALLOWLIST),
  stockContractAllowlist: parseContractAllowlist(env.SIMULATION_STOCK_CONTRACT_ALLOWLIST)
})

let cachedConfiguration: SimulationConfiguration | undefined

const getSimulationConfig = (env?: Record<string, string | undefined>): SimulationConfiguration => {
  if (env !== undefined) return readSimulationConfig(env)
  cachedConfiguration ??= readSimulationConfig(process.env)
  return cachedConfiguration
}

export {
  getSimulationConfig,
  readSimulationConfig,
  parseContractAllowlist
}
export type { SimulationConfiguration }
