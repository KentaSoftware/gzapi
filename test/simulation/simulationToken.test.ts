import { expect } from 'chai'
import sinon from 'sinon'

import {
  SIMULATION_CONTRACT_IDS,
  SIMULATION_ERROR_CODES,
  SIMULATION_ROUTE_SNAPSHOT_STATUSES,
  type SimulationRouteSnapshot,
  type SimulationSnapshotHandle,
  type SimulationSnapshotHandleRepository,
  type SimulationStockSnapshot
} from '../../src/interfaces/simulation.interface'
import { loadSnapshots } from '../../src/services/simulationSnapshotAdapter'
import {
  BASE_SCENARIO_TOKEN_LIFETIME_SECONDS,
  BASE_SCENARIO_TOKEN_MAX_LENGTH,
  SimulationTokenError,
  issueBaseScenarioToken,
  verifyBaseScenarioToken,
  type BaseScenarioTokenDependencies,
  type ValidatedBaseScenario
} from '../../src/services/simulationToken'
import {
  CLIENT_ID,
  ROUTE_ID,
  USER_ID,
  validRouteSnapshot,
  validStockSnapshot
} from './fixtures'

const TOKEN_SECRET = 'simulation-token-test-secret-0001'
const OTHER_TOKEN_SECRET = 'different-server-secret-0002-0123456789'
const BASE_HASH = 'a'.repeat(64)
const FIXED_CLOCK = '2026-11-01T12:00:00.000Z'
const TOKEN_PATTERN = /^sim2\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const objectId = (value: number): string => value.toString(16).padStart(24, '0')

const fixedClock = (isoDateTime: string): (() => Date) => () => new Date(isoDateTime)

interface MutableClock {
  now: Date
  clock: () => Date
}

const mutableClock = (isoDateTime: string): MutableClock => {
  const state: MutableClock = {
    now: new Date(isoDateTime),
    clock: () => state.now
  }
  return state
}

class InMemoryHandleRepository implements SimulationSnapshotHandleRepository {
  readonly records = new Map<string, unknown>()
  insertCalls = 0
  findCalls = 0
  failInsert = false
  failFind = false

  async insert (record: SimulationSnapshotHandle): Promise<void> {
    this.insertCalls += 1
    if (this.failInsert) throw new Error('mongo insert failed with sensitive detail')
    this.records.set(record.handleDigest, record)
  }

  async findByHandleDigest (handleDigest: string): Promise<unknown | null> {
    this.findCalls += 1
    if (this.failFind) throw new Error('mongo find failed with sensitive detail')
    return this.records.get(handleDigest) ?? null
  }
}

const routeAllowlist = [SIMULATION_CONTRACT_IDS.ROUTE]
const stockAllowlist = [SIMULATION_CONTRACT_IDS.STOCK]

const dependencies = (
  repository: SimulationSnapshotHandleRepository,
  overrides: Partial<BaseScenarioTokenDependencies> = {}
): BaseScenarioTokenDependencies => ({
  secret: TOKEN_SECRET,
  clock: fixedClock(FIXED_CLOCK),
  repository,
  routeContractAllowlist: routeAllowlist,
  stockContractAllowlist: stockAllowlist,
  ...overrides
})

const largeRouteSnapshot = (): SimulationRouteSnapshot => ({
  ...clone(validRouteSnapshot),
  stops: Array.from({ length: 20 }, (_, index) => ({
    sequence: index + 1,
    clientId: objectId(100 + index),
    saleIds: [objectId(1000 + index)]
  }))
})

const largeStockSnapshot = (): SimulationStockSnapshot => ({
  ...clone(validStockSnapshot),
  products: Array.from({ length: 50 }, (_, index) => ({
    ...clone(validStockSnapshot.products[0]),
    productId: objectId(2000 + index)
  }))
})

const baseScenario = (
  routeSnapshot: SimulationRouteSnapshot = clone(validRouteSnapshot),
  stockSnapshot: SimulationStockSnapshot = clone(validStockSnapshot)
): ValidatedBaseScenario => ({
  routeSnapshot,
  stockSnapshot,
  versions: {
    routeContractVersion: routeSnapshot.contractVersion,
    stockContractVersion: stockSnapshot.contractVersion,
    rulesVersion: 'simulation-rules-v1'
  },
  baseScenarioHash: BASE_HASH
})

const captureError = async (operation: () => Promise<unknown>): Promise<SimulationTokenError> => {
  try {
    await operation()
  } catch (error) {
    expect(error).to.be.instanceOf(SimulationTokenError)
    return error as SimulationTokenError
  }
  throw new Error('Expected the token operation to fail closed')
}

const storedRecordOf = (repository: InMemoryHandleRepository): SimulationSnapshotHandle => {
  const records = [...repository.records.values()]
  expect(records).to.have.lengthOf(1)
  return records[0] as SimulationSnapshotHandle
}

describe('Simulation base scenario handle token', () => {
  it('S-01a: issues an opaque authenticated handle and verifies the frozen base scenario for the same actor', async () => {
    const repository = new InMemoryHandleRepository()
    const base = baseScenario()
    const store = dependencies(repository)

    const token = await issueBaseScenarioToken(base, { actorId: USER_ID }, store)
    const verified = await verifyBaseScenarioToken(token, { actorId: USER_ID }, store)

    expect(token).to.match(TOKEN_PATTERN)
    expect(token.length).to.be.at.most(BASE_SCENARIO_TOKEN_MAX_LENGTH)
    expect(Buffer.from(token.split('.')[1], 'base64url')).to.have.lengthOf(32)
    expect(Buffer.from(token.split('.')[2], 'base64url')).to.have.lengthOf(32)
    expect(verified).to.deep.equal(base)
    expect(Object.isFrozen(verified.routeSnapshot)).to.equal(true)
    expect(Object.isFrozen(verified.stockSnapshot)).to.equal(true)
    expect(Object.isFrozen(verified.versions)).to.equal(true)
    expect(repository.insertCalls).to.equal(1)
    expect(repository.findCalls).to.equal(1)

    const stored = storedRecordOf(repository)
    expect(stored.actorId).to.equal(USER_ID)
    expect(stored.handleDigest).to.match(/^[a-f0-9]{64}$/)
    expect(token).to.not.contain(stored.handleDigest)
  })

  it('TC-010: issues and verifies a Plan-sized fixture of 20 stops and 50 products with the tiny handle', async () => {
    const repository = new InMemoryHandleRepository()
    const store = dependencies(repository)
    const base = baseScenario(largeRouteSnapshot(), largeStockSnapshot())

    const token = await issueBaseScenarioToken(base, { actorId: USER_ID }, store)
    const verified = await verifyBaseScenarioToken(token, { actorId: USER_ID }, store)

    expect(base.routeSnapshot.stops).to.have.lengthOf(20)
    expect(base.stockSnapshot.products).to.have.lengthOf(50)
    expect(token.length).to.be.lessThan(256)
    expect(token.length).to.be.at.most(BASE_SCENARIO_TOKEN_MAX_LENGTH)
    expect(verified.routeSnapshot.stops).to.have.lengthOf(20)
    expect(verified.stockSnapshot.products).to.have.lengthOf(50)
    expect(verified).to.deep.equal(base)
  })

  it('keeps the frozen snapshots after the issuing caller mutates its own copy', async () => {
    const repository = new InMemoryHandleRepository()
    const base = baseScenario()
    const store = dependencies(repository)

    const token = await issueBaseScenarioToken(base, { actorId: USER_ID }, store)
    base.routeSnapshot.distanceMeters = 999999
    base.stockSnapshot.products[0].presalePriceArs = 1
    const verified = await verifyBaseScenarioToken(token, { actorId: USER_ID }, store)

    expect(verified.routeSnapshot.distanceMeters).to.equal(validRouteSnapshot.distanceMeters)
    expect(verified.stockSnapshot.products[0].presalePriceArs).to.equal(validStockSnapshot.products[0].presalePriceArs)
  })

  it('keeps the handle reusable by its bound actor until expiry', async () => {
    const repository = new InMemoryHandleRepository()
    const clock = mutableClock(FIXED_CLOCK)
    const store = dependencies(repository, { clock: clock.clock })
    const base = baseScenario()

    const token = await issueBaseScenarioToken(base, { actorId: USER_ID }, store)
    clock.now = new Date(clock.now.getTime() + 1000)
    const first = await verifyBaseScenarioToken(token, { actorId: USER_ID }, store)
    clock.now = new Date(clock.now.getTime() + (BASE_SCENARIO_TOKEN_LIFETIME_SECONDS - 2) * 1000)
    const second = await verifyBaseScenarioToken(token, { actorId: USER_ID }, store)

    expect(first).to.deep.equal(base)
    expect(second).to.deep.equal(base)
    expect(repository.insertCalls).to.equal(1)
    expect(repository.findCalls).to.equal(2)
  })

  it('rejects an expired handle with the declared expiration code', async () => {
    const repository = new InMemoryHandleRepository()
    const clock = mutableClock(FIXED_CLOCK)
    const store = dependencies(repository, { clock: clock.clock })
    const token = await issueBaseScenarioToken(baseScenario(), { actorId: USER_ID }, store)

    clock.now = new Date(clock.now.getTime() + (BASE_SCENARIO_TOKEN_LIFETIME_SECONDS + 1) * 1000)
    const error = await captureError(async () => await verifyBaseScenarioToken(token, { actorId: USER_ID }, store))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.TOKEN_EXPIRED)
  })

  it('treats the exact expiration instant as expired', async () => {
    const repository = new InMemoryHandleRepository()
    const clock = mutableClock(FIXED_CLOCK)
    const store = dependencies(repository, { clock: clock.clock })
    const token = await issueBaseScenarioToken(baseScenario(), { actorId: USER_ID }, store)

    clock.now = new Date(clock.now.getTime() + BASE_SCENARIO_TOKEN_LIFETIME_SECONDS * 1000)
    const error = await captureError(async () => await verifyBaseScenarioToken(token, { actorId: USER_ID }, store))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.TOKEN_EXPIRED)
  })

  it('rejects a handle presented by a different actor', async () => {
    const repository = new InMemoryHandleRepository()
    const store = dependencies(repository)
    const token = await issueBaseScenarioToken(baseScenario(), { actorId: USER_ID }, store)

    const error = await captureError(async () => await verifyBaseScenarioToken(token, { actorId: CLIENT_ID }, store))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.TOKEN_INVALID)
  })

  it('rejects a tampered handle before any repository lookup', async () => {
    const repository = new InMemoryHandleRepository()
    const store = dependencies(repository)
    const token = await issueBaseScenarioToken(baseScenario(), { actorId: USER_ID }, store)
    const [prefix, handle, mac] = token.split('.')
    const tampered = `${prefix}.${handle.slice(0, -1)}${handle.endsWith('A') ? 'B' : 'A'}.${mac}`

    const error = await captureError(async () => await verifyBaseScenarioToken(tampered, { actorId: USER_ID }, store))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.TOKEN_INVALID)
    expect(repository.findCalls).to.equal(0)
  })

  it('rejects a tampered authenticator before any repository lookup', async () => {
    const repository = new InMemoryHandleRepository()
    const store = dependencies(repository)
    const token = await issueBaseScenarioToken(baseScenario(), { actorId: USER_ID }, store)
    const [prefix, handle, mac] = token.split('.')
    const tamperedMac = Buffer.from(mac, 'base64url')
    tamperedMac[0] ^= 0xff
    const tampered = `${prefix}.${handle}.${tamperedMac.toString('base64url')}`

    const error = await captureError(async () => await verifyBaseScenarioToken(tampered, { actorId: USER_ID }, store))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.TOKEN_INVALID)
    expect(repository.findCalls).to.equal(0)
  })

  it('rejects a non-canonical authenticator text that decodes to the valid MAC', async () => {
    const repository = new InMemoryHandleRepository()
    const store = dependencies(repository)
    const token = await issueBaseScenarioToken(baseScenario(), { actorId: USER_ID }, store)
    const [prefix, handle, mac] = token.split('.')
    const base64urlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const lastCharacterIndex = base64urlAlphabet.indexOf(mac[mac.length - 1])
    expect(lastCharacterIndex % 4).to.equal(0)
    const equivalentMac = `${mac.slice(0, -1)}${base64urlAlphabet[lastCharacterIndex + 1]}`
    expect(Buffer.from(equivalentMac, 'base64url').toString('hex'))
      .to.equal(Buffer.from(mac, 'base64url').toString('hex'))
    const equivalentToken = `${prefix}.${handle}.${equivalentMac}`
    expect(equivalentToken).to.not.equal(token)

    const error = await captureError(async () => await verifyBaseScenarioToken(equivalentToken, { actorId: USER_ID }, store))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.TOKEN_INVALID)
    expect(repository.findCalls).to.equal(0)
  })

  it('rejects a handle authenticated with a different server secret', async () => {
    const repository = new InMemoryHandleRepository()
    const issuingDependencies = dependencies(repository)
    const verifyingDependencies = dependencies(repository, { secret: OTHER_TOKEN_SECRET })
    const token = await issueBaseScenarioToken(baseScenario(), { actorId: USER_ID }, issuingDependencies)

    const error = await captureError(async () => await verifyBaseScenarioToken(
      token,
      { actorId: USER_ID },
      verifyingDependencies
    ))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.TOKEN_INVALID)
  })

  it('rejects malformed handles instead of interpreting them', async () => {
    const repository = new InMemoryHandleRepository()
    const store = dependencies(repository)
    const malformed = [
      '',
      'not-a-token',
      'sim2.only-two-parts',
      'sim2.abc.def',
      'sim2..abc',
      `sim1.${'a'.repeat(43)}.${'b'.repeat(43)}`,
      `sim2.${'a'.repeat(43)}.${'b'.repeat(42)}`
    ]

    for (const token of malformed) {
      const error = await captureError(async () => await verifyBaseScenarioToken(token, { actorId: USER_ID }, store))
      expect(error.code).to.equal(SIMULATION_ERROR_CODES.TOKEN_INVALID)
    }
    expect(repository.findCalls).to.equal(0)
  })

  it('rejects a handle longer than the token size limit before decoding it', async () => {
    const repository = new InMemoryHandleRepository()
    const store = dependencies(repository)
    const token = `sim2.${'a'.repeat(BASE_SCENARIO_TOKEN_MAX_LENGTH)}.${'b'.repeat(43)}`

    expect(token.length).to.be.greaterThan(BASE_SCENARIO_TOKEN_MAX_LENGTH)
    const error = await captureError(async () => await verifyBaseScenarioToken(token, { actorId: USER_ID }, store))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.TOKEN_INVALID)
    expect(repository.findCalls).to.equal(0)
  })

  it('does not embed snapshot data in the wire token', async () => {
    const repository = new InMemoryHandleRepository()
    const store = dependencies(repository)
    const token = await issueBaseScenarioToken(baseScenario(), { actorId: USER_ID }, store)

    expect(token).to.not.contain('routeSnapshot')
    expect(token).to.not.contain('presalePriceArs')
    expect(token).to.not.contain(ROUTE_ID)
    expect(token).to.not.contain(BASE_HASH)
    expect(() => JSON.parse(token)).to.throw()
  })

  it('rejects a short or blank injected secret as a configuration error without leaking it', async () => {
    const repository = new InMemoryHandleRepository()
    const weakSecrets: Array<string | Buffer> = ['', '   ', 'short-secret', 's'.repeat(31), Buffer.from('short')]
    const strongStore = dependencies(repository)
    const strongToken = await issueBaseScenarioToken(baseScenario(), { actorId: USER_ID }, strongStore)

    for (const secret of weakSecrets) {
      const store = dependencies(repository, { secret })
      const issueError = await captureError(async () => await issueBaseScenarioToken(
        baseScenario(),
        { actorId: USER_ID },
        store
      ))
      const verifyError = await captureError(async () => await verifyBaseScenarioToken(
        strongToken,
        { actorId: USER_ID },
        store
      ))

      expect(issueError.code).to.equal(SIMULATION_ERROR_CODES.CONFIGURATION_UNAVAILABLE)
      expect(verifyError.code).to.equal(SIMULATION_ERROR_CODES.CONFIGURATION_UNAVAILABLE)
      expect(issueError.message).to.not.contain(TOKEN_SECRET)
      expect(verifyError.message).to.not.contain(TOKEN_SECRET)
      if (typeof secret === 'string' && secret.trim() !== '') {
        expect(issueError.message).to.not.contain(secret)
        expect(verifyError.message).to.not.contain(secret)
      }
    }
  })

  it('rejects an invalid clock as a configuration error during issue and verify', async () => {
    const repository = new InMemoryHandleRepository()
    const validStore = dependencies(repository)
    const invalidStore = dependencies(repository, { clock: () => new Date('invalid') })
    const token = await issueBaseScenarioToken(baseScenario(), { actorId: USER_ID }, validStore)

    const issueError = await captureError(async () => await issueBaseScenarioToken(
      baseScenario(),
      { actorId: USER_ID },
      invalidStore
    ))
    const verifyError = await captureError(async () => await verifyBaseScenarioToken(
      token,
      { actorId: USER_ID },
      invalidStore
    ))

    expect(issueError.code).to.equal(SIMULATION_ERROR_CODES.CONFIGURATION_UNAVAILABLE)
    expect(verifyError.code).to.equal(SIMULATION_ERROR_CODES.CONFIGURATION_UNAVAILABLE)
    expect(issueError.message).to.not.contain(TOKEN_SECRET)
    expect(verifyError.message).to.not.contain(TOKEN_SECRET)
  })

  it('rejects an invalid handle lifetime as a configuration error', async () => {
    const repository = new InMemoryHandleRepository()
    const invalidLifetimes = [0, -1, 1.5, Number.NaN]

    for (const lifetimeSeconds of invalidLifetimes) {
      const store = dependencies(repository, { lifetimeSeconds })
      const error = await captureError(async () => await issueBaseScenarioToken(
        baseScenario(),
        { actorId: USER_ID },
        store
      ))

      expect(error.code).to.equal(SIMULATION_ERROR_CODES.CONFIGURATION_UNAVAILABLE)
      expect(error.message).to.not.contain(TOKEN_SECRET)
    }
  })

  it('accepts an injected secret at the minimum strength boundary', async () => {
    const repository = new InMemoryHandleRepository()
    const store = dependencies(repository, { secret: 'k'.repeat(32) })
    const base = baseScenario()

    const token = await issueBaseScenarioToken(base, { actorId: USER_ID }, store)
    const verified = await verifyBaseScenarioToken(token, { actorId: USER_ID }, store)

    expect(verified).to.deep.equal(base)
  })

  it('rejects a blank actor during issue', async () => {
    const repository = new InMemoryHandleRepository()
    const store = dependencies(repository)

    const error = await captureError(async () => await issueBaseScenarioToken(
      baseScenario(),
      { actorId: '   ' },
      store
    ))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.TOKEN_INVALID)
    expect(repository.insertCalls).to.equal(0)
  })

  it('rejects issued snapshots whose route status is not VALIDATED', async () => {
    const repository = new InMemoryHandleRepository()
    const store = dependencies(repository)
    const base = baseScenario()
    base.routeSnapshot.status = SIMULATION_ROUTE_SNAPSHOT_STATUSES.DRAFT

    const error = await captureError(async () => await issueBaseScenarioToken(base, { actorId: USER_ID }, store))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.TOKEN_INVALID)
    expect(repository.insertCalls).to.equal(0)
  })

  it('rejects issued route versions outside the allowlist even for a hand-constructed type', async () => {
    const repository = new InMemoryHandleRepository()
    const store = dependencies(repository)
    const base = baseScenario()
    base.routeSnapshot.contractVersion = 'SIM-ROUTE-SNAPSHOT-002'
    base.versions.routeContractVersion = 'SIM-ROUTE-SNAPSHOT-002'

    const error = await captureError(async () => await issueBaseScenarioToken(base, { actorId: USER_ID }, store))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.TOKEN_INVALID)
    expect(repository.insertCalls).to.equal(0)
  })

  it('rejects issued stock versions outside the allowlist even for a hand-constructed type', async () => {
    const repository = new InMemoryHandleRepository()
    const store = dependencies(repository)
    const base = baseScenario()
    base.stockSnapshot.contractVersion = 'SIM-STOCK-SNAPSHOT-002'
    base.versions.stockContractVersion = 'SIM-STOCK-SNAPSHOT-002'

    const error = await captureError(async () => await issueBaseScenarioToken(base, { actorId: USER_ID }, store))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.TOKEN_INVALID)
    expect(repository.insertCalls).to.equal(0)
  })

  it('rejects issuance when the configured allowlists are empty', async () => {
    const repository = new InMemoryHandleRepository()
    const store = dependencies(repository, { routeContractAllowlist: [], stockContractAllowlist: [] })

    const error = await captureError(async () => await issueBaseScenarioToken(
      baseScenario(),
      { actorId: USER_ID },
      store
    ))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.TOKEN_INVALID)
  })

  it('rejects a base scenario whose declared versions do not match its snapshots', async () => {
    const repository = new InMemoryHandleRepository()
    const store = dependencies(repository)
    const base = baseScenario()
    base.versions.routeContractVersion = 'SIM-ROUTE-SNAPSHOT-002'

    const error = await captureError(async () => await issueBaseScenarioToken(base, { actorId: USER_ID }, store))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.TOKEN_INVALID)
  })

  it('rejects a base scenario hash that is not a canonical digest', async () => {
    const repository = new InMemoryHandleRepository()
    const store = dependencies(repository)
    const base = { ...baseScenario(), baseScenarioHash: 'not-a-hash' }

    const error = await captureError(async () => await issueBaseScenarioToken(base, { actorId: USER_ID }, store))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.TOKEN_INVALID)
  })

  it('returns a repository error when the handle cannot be persisted', async () => {
    const repository = new InMemoryHandleRepository()
    repository.failInsert = true
    const store = dependencies(repository)

    const error = await captureError(async () => await issueBaseScenarioToken(
      baseScenario(),
      { actorId: USER_ID },
      store
    ))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.REPOSITORY_ERROR)
    expect(error.message).to.not.contain('sensitive detail')
  })

  it('returns a repository error when the handle cannot be read back', async () => {
    const repository = new InMemoryHandleRepository()
    const store = dependencies(repository)
    const token = await issueBaseScenarioToken(baseScenario(), { actorId: USER_ID }, store)
    repository.failFind = true

    const error = await captureError(async () => await verifyBaseScenarioToken(token, { actorId: USER_ID }, store))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.REPOSITORY_ERROR)
    expect(error.message).to.not.contain('sensitive detail')
  })

  it('rejects an unknown handle digest', async () => {
    const repository = new InMemoryHandleRepository()
    const store = dependencies(repository)
    const token = await issueBaseScenarioToken(baseScenario(), { actorId: USER_ID }, store)
    repository.records.clear()

    const error = await captureError(async () => await verifyBaseScenarioToken(token, { actorId: USER_ID }, store))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.TOKEN_INVALID)
  })

  it('rejects a stored record whose digest does not match the authenticated handle', async () => {
    const repository = new InMemoryHandleRepository()
    const store = dependencies(repository)
    const token = await issueBaseScenarioToken(baseScenario(), { actorId: USER_ID }, store)
    const stored = storedRecordOf(repository)
    repository.records.set(stored.handleDigest, { ...stored, handleDigest: 'b'.repeat(64) })

    const error = await captureError(async () => await verifyBaseScenarioToken(token, { actorId: USER_ID }, store))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.TOKEN_INVALID)
  })

  it('rejects a stored record whose actor binding was changed', async () => {
    const repository = new InMemoryHandleRepository()
    const store = dependencies(repository)
    const token = await issueBaseScenarioToken(baseScenario(), { actorId: USER_ID }, store)
    const stored = storedRecordOf(repository)
    repository.records.set(stored.handleDigest, { ...stored, actorId: CLIENT_ID })

    const error = await captureError(async () => await verifyBaseScenarioToken(token, { actorId: USER_ID }, store))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.TOKEN_INVALID)
  })

  it('rejects a stored record that fails Zod validation', async () => {
    const repository = new InMemoryHandleRepository()
    const store = dependencies(repository)
    const token = await issueBaseScenarioToken(baseScenario(), { actorId: USER_ID }, store)
    const stored = storedRecordOf(repository)
    repository.records.set(stored.handleDigest, { ...stored, baseScenarioHash: 'not-a-hash' })

    const error = await captureError(async () => await verifyBaseScenarioToken(token, { actorId: USER_ID }, store))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.TOKEN_INVALID)
  })

  it('enforces the route status on the stored record during verification', async () => {
    const repository = new InMemoryHandleRepository()
    const store = dependencies(repository)
    const token = await issueBaseScenarioToken(baseScenario(), { actorId: USER_ID }, store)
    const stored = storedRecordOf(repository)
    repository.records.set(stored.handleDigest, {
      ...stored,
      routeSnapshot: { ...stored.routeSnapshot, status: SIMULATION_ROUTE_SNAPSHOT_STATUSES.DRAFT }
    })

    const error = await captureError(async () => await verifyBaseScenarioToken(token, { actorId: USER_ID }, store))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.TOKEN_INVALID)
  })

  it('enforces the allowlisted versions on the stored record during verification', async () => {
    const repository = new InMemoryHandleRepository()
    const store = dependencies(repository)
    const token = await issueBaseScenarioToken(baseScenario(), { actorId: USER_ID }, store)
    const stored = storedRecordOf(repository)
    repository.records.set(stored.handleDigest, {
      ...stored,
      routeSnapshot: { ...stored.routeSnapshot, contractVersion: 'SIM-ROUTE-SNAPSHOT-002' },
      versions: { ...stored.versions, routeContractVersion: 'SIM-ROUTE-SNAPSHOT-002' }
    })

    const error = await captureError(async () => await verifyBaseScenarioToken(token, { actorId: USER_ID }, store))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.TOKEN_INVALID)
  })

  it('rejects a stored record whose expiration does not follow issuance', async () => {
    const repository = new InMemoryHandleRepository()
    const store = dependencies(repository)
    const token = await issueBaseScenarioToken(baseScenario(), { actorId: USER_ID }, store)
    const stored = storedRecordOf(repository)
    repository.records.set(stored.handleDigest, {
      ...stored,
      expiresAt: new Date(stored.issuedAt.getTime())
    })

    const error = await captureError(async () => await verifyBaseScenarioToken(token, { actorId: USER_ID }, store))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.TOKEN_INVALID)
  })

  it('TC-011: does not reread producers during verification', async () => {
    const routeProducer = { readRouteSnapshot: sinon.stub().resolves(clone(validRouteSnapshot)) }
    const stockProducer = { readStockSnapshot: sinon.stub().resolves(clone(validStockSnapshot)) }
    const snapshots = await loadSnapshots(
      { routeId: ROUTE_ID },
      {
        routeProducer,
        stockProducer,
        routeContractAllowlist: routeAllowlist,
        stockContractAllowlist: stockAllowlist
      }
    )
    const repository = new InMemoryHandleRepository()
    const store = dependencies(repository)
    const base = baseScenario(snapshots.routeSnapshot, snapshots.stockSnapshot)
    const token = await issueBaseScenarioToken(base, { actorId: USER_ID }, store)

    routeProducer.readRouteSnapshot.resetHistory()
    stockProducer.readStockSnapshot.resetHistory()
    const verified = await verifyBaseScenarioToken(token, { actorId: USER_ID }, store)

    expect(routeProducer.readRouteSnapshot.called).to.equal(false)
    expect(stockProducer.readStockSnapshot.called).to.equal(false)
    expect(verified).to.deep.equal(base)
  })
})
