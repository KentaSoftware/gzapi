import { expect } from 'chai'
import { createHash } from 'node:crypto'

import {
  SIMULATION_CONTRACT_IDS,
  SIMULATION_ROUTE_SNAPSHOT_STATUSES,
  type SimulationRouteSnapshot,
  type SimulationSnapshotHandle,
  type SimulationStockSnapshot
} from '../../src/interfaces/simulation.interface'
import SimulationSnapshotHandleModel, {
  SIMULATION_SNAPSHOT_HANDLE_COLLECTION
} from '../../src/models/simulationSnapshotHandle'
import {
  BASE_HASH,
  CAPTURED_AT,
  CLIENT_ID,
  USER_ID,
  validRouteSnapshot,
  validStockSnapshot
} from './fixtures'
import { executePreHook, expectHookRejection, hasIndex } from './mongoose-hooks'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const IMMUTABLE_FIELDS = [
  'handleDigest',
  'actorId',
  'routeSnapshot',
  'stockSnapshot',
  'versions',
  'baseScenarioHash',
  'issuedAt',
  'expiresAt'
] as const

const VERSION_FIELDS = ['routeContractVersion', 'stockContractVersion', 'rulesVersion'] as const

const handleRecord = (): SimulationSnapshotHandle => ({
  handleDigest: createHash('sha256').update('handle-fixture', 'utf8').digest('hex'),
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

describe('Simulation persistence - snapshot handle model', () => {
  it('TC-010: validates a complete frozen handle record without immutable-run delete guards', () => {
    const document = new SimulationSnapshotHandleModel(handleRecord())

    expect(document.validateSync()).to.equal(undefined)
    expect(SimulationSnapshotHandleModel.modelName).to.equal('simulationSnapshotHandle')
    expect(SimulationSnapshotHandleModel.schema.get('collection')).to.equal(SIMULATION_SNAPSHOT_HANDLE_COLLECTION)
    expect(SIMULATION_SNAPSHOT_HANDLE_COLLECTION).to.equal('simulationsnapshothandles')
    expect(SimulationSnapshotHandleModel.schema.options.versionKey).to.equal(false)
  })

  it('requires the digest, actor, snapshots, versions, hash and expiry', () => {
    const missingError = new SimulationSnapshotHandleModel().validateSync()

    expect(missingError?.errors.handleDigest).to.not.equal(undefined)
    expect(missingError?.errors.actorId).to.not.equal(undefined)
    expect(missingError?.errors.routeSnapshot).to.not.equal(undefined)
    expect(missingError?.errors.stockSnapshot).to.not.equal(undefined)
    expect(missingError?.errors.versions).to.not.equal(undefined)
    expect(missingError?.errors.baseScenarioHash).to.not.equal(undefined)
    expect(missingError?.errors.issuedAt).to.not.equal(undefined)
    expect(missingError?.errors.expiresAt).to.not.equal(undefined)
  })

  it('rejects a handle digest or base scenario hash that is not a canonical SHA-256 digest', () => {
    const invalidDigest = new SimulationSnapshotHandleModel({ ...handleRecord(), handleDigest: 'not-a-digest' })
    expect(invalidDigest.validateSync()?.errors.handleDigest).to.not.equal(undefined)

    const invalidHash = new SimulationSnapshotHandleModel({ ...handleRecord(), baseScenarioHash: 'not-a-hash' })
    expect(invalidHash.validateSync()?.errors.baseScenarioHash).to.not.equal(undefined)
  })

  it('rejects a route snapshot that is not VALIDATED', () => {
    const draft = new SimulationSnapshotHandleModel({
      ...handleRecord(),
      routeSnapshot: {
        ...clone(validRouteSnapshot),
        status: SIMULATION_ROUTE_SNAPSHOT_STATUSES.DRAFT
      }
    })

    expect(draft.validateSync()?.errors.routeSnapshot).to.not.equal(undefined)
  })

  it('rejects snapshots that fail the declared strict schemas', () => {
    const extraField = new SimulationSnapshotHandleModel({
      ...handleRecord(),
      routeSnapshot: { ...clone(validRouteSnapshot), unexpectedField: true }
    })
    expect(extraField.validateSync()?.errors.routeSnapshot).to.not.equal(undefined)

    const negativePrice = new SimulationSnapshotHandleModel({
      ...handleRecord(),
      stockSnapshot: {
        ...clone(validStockSnapshot),
        products: [{ ...clone(validStockSnapshot.products[0]), presalePriceArs: -1 }]
      }
    })
    expect(negativePrice.validateSync()?.errors.stockSnapshot).to.not.equal(undefined)
  })

  it('rejects declared versions that do not match the frozen snapshots', () => {
    const record = handleRecord()
    const mismatch = new SimulationSnapshotHandleModel({
      ...record,
      versions: { ...record.versions, routeContractVersion: 'SIM-ROUTE-SNAPSHOT-002' }
    })

    expect(mismatch.validateSync()?.errors.versions).to.not.equal(undefined)
  })

  it('rejects an expiration that does not follow issuance', () => {
    const record = handleRecord()
    const invalidExpiry = new SimulationSnapshotHandleModel({
      ...record,
      expiresAt: new Date(record.issuedAt.getTime())
    })

    expect(invalidExpiry.validateSync()?.errors.expiresAt).to.not.equal(undefined)
  })

  it('declares every frozen handle field immutable', () => {
    for (const field of IMMUTABLE_FIELDS) {
      expect(SimulationSnapshotHandleModel.schema.path(field)?.options.immutable, field).to.equal(true)
    }
    for (const field of VERSION_FIELDS) {
      expect(SimulationSnapshotHandleModel.schema.path(`versions.${field}`)?.options.immutable, field).to.equal(true)
    }
  })

  it('ignores document writes to frozen evidence after hydration', () => {
    const record = handleRecord()
    const document = SimulationSnapshotHandleModel.hydrate(record)
    const mutations: Array<[string, () => void]> = [
      ['handleDigest', () => { document.handleDigest = 'b'.repeat(64) }],
      ['actorId', () => { document.actorId = CLIENT_ID }],
      ['routeSnapshot', () => { document.routeSnapshot = { ...clone(validRouteSnapshot), distanceMeters: 1 } }],
      ['stockSnapshot', () => { document.stockSnapshot = { ...clone(validStockSnapshot), capturedAt: '2024-02-29T12:00:00.000Z' } }],
      ['versions', () => { document.versions = { ...record.versions, rulesVersion: 'simulation-rules-v2' } }],
      ['baseScenarioHash', () => { document.baseScenarioHash = 'c'.repeat(64) }],
      ['issuedAt', () => { document.issuedAt = new Date(0) }],
      ['expiresAt', () => { document.expiresAt = new Date(1) }]
    ]

    for (const [field, mutate] of mutations) {
      mutate()
      expect(document.isModified(field), field).to.equal(false)
    }
    expect(document.handleDigest).to.equal(record.handleDigest)
    expect(document.actorId).to.equal(record.actorId)
    expect(document.routeSnapshot).to.deep.equal(record.routeSnapshot)
    expect(document.stockSnapshot).to.deep.equal(record.stockSnapshot)
    expect(document.versions.rulesVersion).to.equal(record.versions.rulesVersion)
    expect(document.baseScenarioHash).to.equal(record.baseScenarioHash)
    expect(document.issuedAt.getTime()).to.equal(record.issuedAt.getTime())
    expect(document.expiresAt.getTime()).to.equal(record.expiresAt.getTime())
  })

  it('rejects forced document writes and model update operations before persistence', async () => {
    const document = SimulationSnapshotHandleModel.hydrate(handleRecord())
    document.set('actorId', CLIENT_ID, { overwriteImmutable: true })
    await expectHookRejection(SimulationSnapshotHandleModel.schema, 'save', document)

    const updateOperations = ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'bulkWrite']
    for (const operation of updateOperations) {
      await expectHookRejection(
        SimulationSnapshotHandleModel.schema,
        operation,
        operation === 'bulkWrite' ? [] : SimulationSnapshotHandleModel.updateOne({}, { $set: { actorId: CLIENT_ID } })
      )
    }
  })

  it('rejects version identifiers containing whitespace or control characters', () => {
    const invalidIdentifiers = ['simulation rules v1', 'simulation\u0000rules-v1']

    for (const identifier of invalidIdentifiers) {
      for (const field of VERSION_FIELDS) {
        const record = handleRecord()
        const document = new SimulationSnapshotHandleModel({
          ...record,
          versions: { ...record.versions, [field]: identifier }
        })
        expect(document.versions.validateSync()?.errors[field], field).to.not.equal(undefined)
      }
    }
  })

  it('declares a unique handle-digest index and an expiry TTL index', () => {
    expect(hasIndex(SimulationSnapshotHandleModel.schema, { handleDigest: 1 }, true)).to.equal(true)
    expect(hasIndex(SimulationSnapshotHandleModel.schema, { expiresAt: 1 })).to.equal(true)

    const ttlIndex = SimulationSnapshotHandleModel.schema
      .indexes()
      .find(([fields]) => JSON.stringify(fields) === JSON.stringify({ expiresAt: 1 }))
    expect(ttlIndex?.[1].expireAfterSeconds).to.equal(0)
    expect(ttlIndex?.[1].name).to.equal('idx_simulation_snapshot_handle_expires_ttl')

    const digestIndex = SimulationSnapshotHandleModel.schema
      .indexes()
      .find(([fields]) => JSON.stringify(fields) === JSON.stringify({ handleDigest: 1 }))
    expect(digestIndex?.[1].name).to.equal('idx_simulation_snapshot_handle_digest_unique')
  })

  it('permits TTL deletion of expired handles', async () => {
    const deleteOne = SimulationSnapshotHandleModel.hydrate(handleRecord())
    await executePreHook(SimulationSnapshotHandleModel.schema, 'deleteOne', deleteOne)

    const deleteMany = SimulationSnapshotHandleModel.deleteMany({})
    await executePreHook(SimulationSnapshotHandleModel.schema, 'deleteMany', deleteMany)

    const findOneAndDelete = SimulationSnapshotHandleModel.findOneAndDelete({ handleDigest: handleRecord().handleDigest })
    await executePreHook(SimulationSnapshotHandleModel.schema, 'findOneAndDelete', findOneAndDelete)
  })
})
