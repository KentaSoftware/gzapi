import { expect } from 'chai'

import {
  getSimulationConfig,
  parseContractAllowlist,
  parseSimulationFlag,
  readSimulationConfig
} from '../../src/config/simulation'

describe('Simulation contract - configuration', () => {
  it('TC-013: derives disabled defaults from an empty environment', () => {
    const config = getSimulationConfig({})
    expect(config.enabled).to.equal(false)
    expect(config.routeContractAllowlist).to.deep.equal([])
    expect(config.stockContractAllowlist).to.deep.equal([])
    expect(Object.isFrozen(config.routeContractAllowlist)).to.equal(true)
    expect(Object.isFrozen(config.stockContractAllowlist)).to.equal(true)
    expect(readSimulationConfig({}).enabled).to.equal(false)
  })

  it('TC-013: reads explicit, false, and blank environment values', () => {
    expect(readSimulationConfig({ SIMULATION_ENABLED: 'true' }).enabled).to.equal(true)
    expect(readSimulationConfig({ SIMULATION_ENABLED: 'false' }).enabled).to.equal(false)
    expect(readSimulationConfig({ SIMULATION_ENABLED: '   ' }).enabled).to.equal(false)
    expect(readSimulationConfig({ SIMULATION_ROUTE_CONTRACT_ALLOWLIST: '  ' }).routeContractAllowlist).to.deep.equal([])
    expect(readSimulationConfig({ SIMULATION_STOCK_CONTRACT_ALLOWLIST: '   ' }).stockContractAllowlist).to.deep.equal([])
    expect(() => readSimulationConfig({ SIMULATION_ENABLED: '1' })).to.throw()
  })

  it('TC-013: accepts only explicit boolean flag values', () => {
    expect(parseSimulationFlag(undefined)).to.equal(false)
    expect(parseSimulationFlag('')).to.equal(false)
    expect(parseSimulationFlag('true')).to.equal(true)
    expect(parseSimulationFlag('false')).to.equal(false)
    expect(() => parseSimulationFlag('1')).to.throw()
    expect(() => parseSimulationFlag('TRUE')).to.throw()
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
