import { expect } from 'chai'
import { createHash } from 'node:crypto'

import {
  SIMULATION_CONTRACT_IDS,
  type SimulationRouteSnapshot,
  type SimulationSnapshotHandle,
  type SimulationStockSnapshot
} from '../../src/interfaces/simulation.interface'
import {
  createSimulationSnapshotHandleMongoRepository,
  type SimulationSnapshotHandleMongoDriver
} from '../../src/services/simulationSnapshotHandleMongoRepository'
import {
  issueBaseScenarioToken,
  verifyBaseScenarioToken,
  type BaseScenarioTokenDependencies,
  type ValidatedBaseScenario
} from '../../src/services/simulationToken'
import {
  BASE_HASH,
  CAPTURED_AT,
  USER_ID,
  validRouteSnapshot,
  validStockSnapshot
} from './fixtures'

const TOKEN_SECRET = 'simulation-token-test-secret-0001'

const baseScenario = (): ValidatedBaseScenario => ({
  routeSnapshot: clone(validRouteSnapshot) as SimulationRouteSnapshot,
  stockSnapshot: clone(validStockSnapshot) as SimulationStockSnapshot,
  versions: {
    routeContractVersion: SIMULATION_CONTRACT_IDS.ROUTE,
    stockContractVersion: SIMULATION_CONTRACT_IDS.STOCK,
    rulesVersion: 'simulation-rules-v1'
  },
  baseScenarioHash: BASE_HASH
})

const tokenDependencies = (repository: ReturnType<typeof createSimulationSnapshotHandleMongoRepository>): BaseScenarioTokenDependencies => ({
  secret: TOKEN_SECRET,
  clock: () => new Date(CAPTURED_AT),
  repository,
  routeContractAllowlist: [SIMULATION_CONTRACT_IDS.ROUTE],
  stockContractAllowlist: [SIMULATION_CONTRACT_IDS.STOCK]
})

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const handleRecord = (): SimulationSnapshotHandle => ({
  handleDigest: createHash('sha256').update('handle-repository-fixture', 'utf8').digest('hex'),
  actorId: USER_ID,
  routeSnapshot: clone(validRouteSnapshot) as SimulationRouteSnapshot,
  stockSnapshot: clone(validStockSnapshot) as SimulationStockSnapshot,
  versions: {
    routeContractVersion: SIMULATION_CONTRACT_IDS.ROUTE,
    stockContractVersion: SIMULATION_CONTRACT_IDS.STOCK,
    rulesVersion: 'simulation-rules-v1'
  },
  baseScenarioHash: BASE_HASH,
  issuedAt: new Date(CAPTURED_AT),
  expiresAt: new Date(Date.parse(CAPTURED_AT) + 15 * 60 * 1000)
})

class InMemoryDriver implements SimulationSnapshotHandleMongoDriver {
  readonly records = new Map<string, unknown>()
  insertCalls = 0
  findCalls = 0
  failInsert = false
  failFind = false
  leanMetadata = false

  async insert (record: SimulationSnapshotHandle): Promise<void> {
    this.insertCalls += 1
    if (this.failInsert) throw new Error('insert failed')
    this.records.set(record.handleDigest, record)
  }

  async findByHandleDigest (handleDigest: string): Promise<unknown | null> {
    this.findCalls += 1
    if (this.failFind) throw new Error('find failed')
    const record = this.records.get(handleDigest)
    if (record === undefined || !this.leanMetadata) return record ?? null
    return {
      _id: USER_ID,
      __v: 0,
      createdAt: new Date(CAPTURED_AT),
      updatedAt: new Date(CAPTURED_AT),
      ...(record as Record<string, unknown>)
    }
  }
}

describe('Simulation persistence - snapshot handle Mongo repository', () => {
  it('TC-010: inserts the frozen record once and reads it back by its deterministic digest', async () => {
    const driver = new InMemoryDriver()
    const repository = createSimulationSnapshotHandleMongoRepository(driver)
    const record = handleRecord()

    await repository.insert(record)
    const found = await repository.findByHandleDigest(record.handleDigest)

    expect(driver.insertCalls).to.equal(1)
    expect(driver.findCalls).to.equal(1)
    expect(found).to.deep.equal(record)
  })

  it('S-01: maps a lean Mongo document back to the exact domain record', async () => {
    const driver = new InMemoryDriver()
    driver.leanMetadata = true
    const repository = createSimulationSnapshotHandleMongoRepository(driver)
    const record = handleRecord()

    await repository.insert(record)
    const found = await repository.findByHandleDigest(record.handleDigest)

    expect(found).to.deep.equal(record)
    expect(found).to.not.have.property('_id')
    expect(found).to.not.have.property('createdAt')
    expect(found).to.not.have.property('updatedAt')
    expect(found).to.not.have.property('__v')
  })

  it('S-01a: verifies an issued handle whose lookup returns lean Mongo metadata', async () => {
    const driver = new InMemoryDriver()
    driver.leanMetadata = true
    const repository = createSimulationSnapshotHandleMongoRepository(driver)
    const store = tokenDependencies(repository)
    const base = baseScenario()

    const token = await issueBaseScenarioToken(base, { actorId: USER_ID }, store)
    const verified = await verifyBaseScenarioToken(token, { actorId: USER_ID }, store)

    expect(verified).to.deep.equal(base)
  })

  it('returns null for an unknown digest instead of throwing or fabricating a record', async () => {
    const driver = new InMemoryDriver()
    const repository = createSimulationSnapshotHandleMongoRepository(driver)

    const found = await repository.findByHandleDigest('b'.repeat(64))

    expect(found).to.equal(null)
  })

  it('normalizes an undefined driver result to null', async () => {
    const driver = new InMemoryDriver()
    driver.findByHandleDigest = async () => undefined
    const repository = createSimulationSnapshotHandleMongoRepository(driver)

    const found = await repository.findByHandleDigest('c'.repeat(64))

    expect(found).to.equal(null)
  })

  it('propagates driver insert failures for the token layer to map', async () => {
    const driver = new InMemoryDriver()
    driver.failInsert = true
    const repository = createSimulationSnapshotHandleMongoRepository(driver)

    let failure: unknown
    try {
      await repository.insert(handleRecord())
    } catch (error) {
      failure = error
    }

    expect(failure).to.be.instanceOf(Error)
    expect((failure as Error).message).to.contain('insert failed')
  })

  it('propagates driver lookup failures for the token layer to map', async () => {
    const driver = new InMemoryDriver()
    driver.failFind = true
    const repository = createSimulationSnapshotHandleMongoRepository(driver)

    let failure: unknown
    try {
      await repository.findByHandleDigest('d'.repeat(64))
    } catch (error) {
      failure = error
    }

    expect(failure).to.be.instanceOf(Error)
    expect((failure as Error).message).to.contain('find failed')
  })
})
