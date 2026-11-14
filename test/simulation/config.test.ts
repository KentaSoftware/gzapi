import { expect } from 'chai'

import {
  getSimulationConfig,
  parseContractAllowlist,
  readSimulationConfig
} from '../../src/config/simulation'

describe('Simulation contract - configuration', () => {
  it('TC-013: derives empty allowlists from an empty environment', () => {
    const config = getSimulationConfig({})
    expect(config.routeContractAllowlist).to.deep.equal([])
    expect(config.stockContractAllowlist).to.deep.equal([])
    expect(Object.isFrozen(config.routeContractAllowlist)).to.equal(true)
    expect(Object.isFrozen(config.stockContractAllowlist)).to.equal(true)
  })

  it('TC-013: ignores the retired flag and reads blank allowlists', () => {
    expect(readSimulationConfig({ SIMULATION_ENABLED: 'false' })).to.deep.equal(readSimulationConfig({ SIMULATION_ENABLED: 'invalid' }))
    expect(readSimulationConfig({ SIMULATION_ROUTE_CONTRACT_ALLOWLIST: '  ' }).routeContractAllowlist).to.deep.equal([])
    expect(readSimulationConfig({ SIMULATION_STOCK_CONTRACT_ALLOWLIST: '   ' }).stockContractAllowlist).to.deep.equal([])
  })

  it('TC-030: validates bounded, unique contract version identifiers', () => {
    expect(parseContractAllowlist(undefined)).to.deep.equal([])
    expect(parseContractAllowlist(' SIM-ROUTE-SNAPSHOT-001 , SIM-ROUTE-SNAPSHOT-002 ')).to.deep.equal([
      'SIM-ROUTE-SNAPSHOT-001',
      'SIM-ROUTE-SNAPSHOT-002'
    ])
    expect(() => parseContractAllowlist('SIM-ROUTE-SNAPSHOT-001,SIM-ROUTE-SNAPSHOT-001')).to.throw()
    expect(() => parseContractAllowlist('SIM ROUTE')).to.throw()
    expect(() => parseContractAllowlist(',')).to.throw()
  })
})
