const { createHash } = require('crypto')
const { MongoClient } = require('mongodb')

const MIGRATION_ID = 'simulation-004-verify'

const TARGETS = [
  {
    name: 'simulationruns',
    indexes: [
      { name: 'idx_simulation_run_route_created', key: { sourceRouteId: 1, createdAt: -1 }, unique: false },
      { name: 'idx_simulation_run_status_created', key: { status: 1, createdAt: -1 }, unique: false }
    ]
  },
  {
    name: 'simulationconfigversions',
    indexes: [
      { name: 'idx_simulation_config_logical_version_unique', key: { vehicleCode: 1, zoneCode: 1, 'period.from': 1, 'period.to': 1, version: 1 }, unique: true },
      { name: 'idx_simulation_config_status_period', key: { status: 1, 'period.from': 1, 'period.to': 1 }, unique: false }
    ]
  },
  {
    name: 'simulationpresetversions',
    indexes: [
      { name: 'idx_simulation_preset_version_unique', key: { name: 1, version: 1 }, unique: true },
      { name: 'idx_simulation_preset_status_created', key: { status: 1, createdAt: -1 }, unique: false }
    ]
  }
]

class MigrationSafetyError extends Error {}

const requiredValue = (values, name) => {
  const value = values.get(name)
  if (value === undefined || value === '') throw new MigrationSafetyError(`Missing required --${name}`)
  return value
}

const parseArguments = (argv) => {
  const values = new Map()
  let dryRun = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--dry-run') {
      dryRun = true
      continue
    }
    if (!argument.startsWith('--')) throw new MigrationSafetyError(`Unexpected argument ${argument}`)
    const value = argv[index + 1]
    if (value === undefined || value === '' || value.startsWith('--')) throw new MigrationSafetyError(`Missing value for ${argument}`)
    values.set(argument.slice(2), value)
    index += 1
  }

  const uri = requiredValue(values, 'uri')
  const environment = requiredValue(values, 'environment')
  const confirmation = requiredValue(values, 'confirm-target')
  const approvalId = requiredValue(values, 'approval-id')
  if (!/^mongodb(\+srv)?:\/\//.test(uri)) throw new MigrationSafetyError('Target URI must be a MongoDB URI')
  if (confirmation !== environment) throw new MigrationSafetyError('Target confirmation must exactly match --environment')
  return { uri, environment, confirmation, approvalId, dryRun }
}

const targetFingerprint = (uri) => createHash('sha256').update(uri).digest('hex')

const printArtifact = (status, options, details) => {
  process.stdout.write(`${JSON.stringify({
    migration: MIGRATION_ID,
    status,
    generatedAt: new Date().toISOString(),
    targetFingerprint: targetFingerprint(options.uri),
    environment: options.environment,
    approvalId: options.approvalId,
    ...details
  }, null, 2)}\n`)
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isDate = (value) => value instanceof Date && !Number.isNaN(value.getTime())
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''
const isPositiveInteger = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const isNonNegativeNumber = (value) => isFiniteNumber(value) && value >= 0
const isMoney = (value, allowNegative = false) => {
  if (!isFiniteNumber(value) || (!allowNegative && value < 0)) return false
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-9
}
const isLabel = (value) => isNonEmptyString(value) && value.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(value)
const isBoundedIdentifier = (value) => isNonEmptyString(value) && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
const isContractVersion = (value) => isNonEmptyString(value) && value.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
const isObjectIdString = (value) => typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value)
const isCivilDateString = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}
const isIsoDateTimeString = (value) => {
  if (typeof value !== 'string') return false
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false
  if (!isCivilDateString(value.slice(0, 10))) return false
  return !Number.isNaN(new Date(value).getTime())
}
const isPersistedIdentifier = (value) => {
  if (typeof value === 'string') return isObjectIdString(value) && value !== '000000000000000000000000'
  if (value !== null && typeof value === 'object' && typeof value.toHexString === 'function') {
    return value.toHexString() !== '000000000000000000000000'
  }
  return false
}
const isMeasure = (value) => isObject(value) &&
  isFiniteNumber(value.value) && value.value > 0 &&
  isNonEmptyString(value.unit) && value.unit.length <= 16 && /^[A-Za-z][A-Za-z0-9./_-]*$/.test(value.unit)
const ROUTE_STATUSES = ['VALIDATED', 'DRAFT', 'CANCELLED']
const RISK_CODES = ['INCOMPLETE_DATA', 'CAPACITY_EXCEEDED_WEIGHT', 'CAPACITY_EXCEEDED_VOLUME', 'NEGATIVE_MARGIN']
const isNumericRecord = (value, requireEntry) => {
  if (!isObject(value)) return false
  const entries = Object.entries(value)
  if (requireEntry && entries.length === 0) return false
  return entries.every(([key, entry]) => isBoundedIdentifier(key) && isNonNegativeNumber(entry))
}
const hasUniqueValues = (values) => new Set(values).size === values.length
const isStatus = (value) => value === 'ACTIVE' || value === 'ARCHIVED'

const isValidOverrides = (value) => {
  if (!Array.isArray(value) || value.length > 64) return false
  if (!value.every((entry) => isObject(entry) && isBoundedIdentifier(entry.key) && isNonNegativeNumber(entry.value))) return false
  return hasUniqueValues(value.map((entry) => entry.key))
}

const isValidDirectLoad = (value) => {
  if (!Array.isArray(value) || value.length > 10000) return false
  if (!value.every((entry) => isObject(entry) &&
    isObjectIdString(entry.productId) &&
    isNonNegativeNumber(entry.quantity) &&
    isNonNegativeNumber(entry.projectedSalesQuantity) &&
    entry.projectedSalesQuantity <= entry.quantity)) return false
  return hasUniqueValues(value.map((entry) => entry.productId))
}

const validateRouteSnapshot = (snapshot, id, failures) => {
  if (!isObject(snapshot)) {
    failures.push(`Run ${id} has a malformed route snapshot`)
    return
  }
  if (!isContractVersion(snapshot.contractVersion)) failures.push(`Run ${id} has an invalid route contract version`)
  if (!isIsoDateTimeString(snapshot.capturedAt)) failures.push(`Run ${id} has an invalid route capture timestamp`)
  if (!isObjectIdString(snapshot.routeId)) failures.push(`Run ${id} has an invalid route identifier`)
  if (!ROUTE_STATUSES.includes(snapshot.status)) failures.push(`Run ${id} has an invalid route status`)
  if (!isLabel(snapshot.zoneCode)) failures.push(`Run ${id} has an invalid route zone`)
  if (!Array.isArray(snapshot.stops) || snapshot.stops.length === 0 || snapshot.stops.length > 1000) {
    failures.push(`Run ${id} has no route stops`)
  } else {
    const sequences = []
    const saleIds = []
    for (const stop of snapshot.stops) {
      if (!isObject(stop) || !isPositiveInteger(stop.sequence) || !isObjectIdString(stop.clientId) ||
        !Array.isArray(stop.saleIds) || stop.saleIds.length === 0 || stop.saleIds.length > 1000 || !stop.saleIds.every(isObjectIdString)) {
        failures.push(`Run ${id} has an invalid route stop`)
        break
      }
      sequences.push(String(stop.sequence))
      saleIds.push(...stop.saleIds)
    }
    if (!hasUniqueValues(sequences)) failures.push(`Run ${id} has duplicate route stop sequences`)
    if (!hasUniqueValues(saleIds)) failures.push(`Run ${id} has duplicate route sale references`)
  }
  if (!isNonNegativeNumber(snapshot.distanceMeters) || !isNonNegativeNumber(snapshot.durationSeconds)) failures.push(`Run ${id} has invalid route metrics`)
  if (!isObject(snapshot.vehicle) || !isLabel(snapshot.vehicle.vehicleCode) ||
    !isFiniteNumber(snapshot.vehicle.fuelConsumptionLitersPer100Km) || snapshot.vehicle.fuelConsumptionLitersPer100Km <= 0) {
    failures.push(`Run ${id} has an invalid route vehicle`)
  }
  if (!isObject(snapshot.capacity) || !isMeasure(snapshot.capacity.maxWeight) || !isMeasure(snapshot.capacity.maxVolume)) {
    failures.push(`Run ${id} has an invalid route capacity`)
  }
  if (!isMoney(snapshot.tollsArs) || !isMoney(snapshot.parkingArs)) failures.push(`Run ${id} has invalid route costs`)
}

const validateStockSnapshot = (snapshot, id, failures) => {
  if (!isObject(snapshot)) {
    failures.push(`Run ${id} has a malformed stock snapshot`)
    return
  }
  if (!isContractVersion(snapshot.contractVersion)) failures.push(`Run ${id} has an invalid stock contract version`)
  if (!isIsoDateTimeString(snapshot.capturedAt)) failures.push(`Run ${id} has an invalid stock capture timestamp`)
  if (!Array.isArray(snapshot.products) || snapshot.products.length === 0 || snapshot.products.length > 10000) {
    failures.push(`Run ${id} has no stock products`)
    return
  }
  for (const product of snapshot.products) {
    if (!isObject(product) || !isObjectIdString(product.productId) || !isNonNegativeNumber(product.availableQuantity) ||
      !isMoney(product.unitCostArs) || !isMoney(product.presalePriceArs) || !isMeasure(product.weight) || !isMeasure(product.volume)) {
      failures.push(`Run ${id} has an invalid stock product`)
      break
    }
  }
  if (!hasUniqueValues(snapshot.products.filter(isObject).map((product) => product.productId))) {
    failures.push(`Run ${id} has duplicate stock products`)
  }
}

const validateVariant = (variant, id, failures) => {
  if (!isObject(variant) || !isLabel(variant.name) || !isValidOverrides(variant.overrides) || !isValidDirectLoad(variant.directLoad)) {
    failures.push(`Run ${id} has an invalid variant`)
    return
  }
  if (variant.presetVersionId !== undefined && !isObjectIdString(variant.presetVersionId)) failures.push(`Run ${id} has an invalid preset reference`)
}

const validateCalculation = (calculation, id, failures) => {
  if (!isObject(calculation)) {
    failures.push(`Run ${id} has no calculation evidence`)
    return
  }
  if (typeof calculation.baseScenarioHash !== 'string' || !/^[a-f0-9]{64}$/.test(calculation.baseScenarioHash)) failures.push(`Run ${id} has an invalid calculation hash`)
  if (!isBoundedIdentifier(calculation.variantId)) failures.push(`Run ${id} has an invalid variant identifier`)
  if (calculation.dataQuality !== 'COMPLETE' && calculation.dataQuality !== 'INCOMPLETE') failures.push(`Run ${id} has invalid data quality`)
  if (!['VIABLE', 'NOT_VIABLE', 'INCOMPLETE'].includes(calculation.viability)) failures.push(`Run ${id} has invalid viability`)
  if (typeof calculation.recommended !== 'boolean') failures.push(`Run ${id} has no recommendation evidence`)
  if (calculation.recommended === true && (calculation.dataQuality !== 'COMPLETE' || calculation.viability !== 'VIABLE')) {
    failures.push(`Run ${id} recommends an incomplete or non-viable calculation`)
  }
  if (!isIsoDateTimeString(calculation.calculatedAt)) failures.push(`Run ${id} has an invalid calculation timestamp`)
  if (!Array.isArray(calculation.risks) || calculation.risks.length > 4 ||
    !calculation.risks.every((risk) => RISK_CODES.includes(risk)) || !hasUniqueValues(calculation.risks)) {
    failures.push(`Run ${id} has invalid calculation risks`)
  }
  if (!Array.isArray(calculation.components) || calculation.components.length > 64) {
    failures.push(`Run ${id} has invalid calculation components`)
  } else {
    const codes = []
    for (const component of calculation.components) {
      if (!isObject(component) || !isBoundedIdentifier(component.code) || !isMoney(component.amountArs)) {
        failures.push(`Run ${id} has an invalid calculation component`)
        break
      }
      codes.push(component.code)
    }
    if (!hasUniqueValues(codes)) failures.push(`Run ${id} has duplicate calculation components`)
  }
  const totals = calculation.totals
  if (!isObject(totals) || !isMoney(totals.revenueArs) || !isMoney(totals.merchandiseCostArs) ||
    !isMoney(totals.operatingCostArs) || !isMoney(totals.marginArs, true)) {
    failures.push(`Run ${id} has invalid calculation totals`)
  }
}

const normalizeKey = (key) => JSON.stringify(Object.entries(key))

const INDEX_OPTION_KEYS = ['unique', 'sparse', 'expireAfterSeconds', 'partialFilterExpression', 'collation']

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    )
  }
  return value
}

const normalizeIndexOption = (key, value) => {
  if (key === 'unique' || key === 'sparse') return Boolean(value)
  if (value === undefined) return null
  return canonicalize(value)
}

const sameIndexOptions = (existing, expected) => INDEX_OPTION_KEYS.every((key) => {
  return JSON.stringify(normalizeIndexOption(key, existing[key])) === JSON.stringify(normalizeIndexOption(key, expected[key]))
})

const sameIndex = (existing, expected) => {
  if (normalizeKey(existing.key) !== normalizeKey(expected.key)) return false
  return sameIndexOptions(existing, expected)
}

const validateRun = (run, failures) => {
  const id = String(run._id)
  if (!isStatus(run.status)) failures.push(`Run ${id} has an invalid status`)
  if (!isPersistedIdentifier(run.createdBy)) failures.push(`Run ${id} has no actor evidence`)
  if (!isNonEmptyString(run.sourceRouteId)) failures.push(`Run ${id} has no source route`)
  validateRouteSnapshot(run.routeSnapshot, id, failures)
  validateStockSnapshot(run.stockSnapshot, id, failures)
  if (typeof run.baseScenarioHash !== 'string' || !/^[a-f0-9]{64}$/.test(run.baseScenarioHash)) failures.push(`Run ${id} has an invalid base scenario hash`)
  validateVariant(run.variant, id, failures)
  validateCalculation(run.calculation, id, failures)
  if (isObject(run.calculation) && run.calculation.baseScenarioHash !== run.baseScenarioHash) failures.push(`Run ${id} has mismatched calculation evidence`)
  if (!isObject(run.versions)) {
    failures.push(`Run ${id} has no version evidence`)
    return
  }
  for (const field of ['rulesVersion', 'configurationVersion', 'routeContractVersion', 'stockContractVersion']) {
    if (!isNonEmptyString(run.versions[field])) failures.push(`Run ${id} has no ${field}`)
  }
  if (!isDate(run.versions.calculatedAt)) failures.push(`Run ${id} has no calculation timestamp`)
  if (isObject(run.routeSnapshot) && isNonEmptyString(run.versions.routeContractVersion) && run.routeSnapshot.contractVersion !== run.versions.routeContractVersion) {
    failures.push(`Run ${id} has mismatched route contract evidence`)
  }
  if (isObject(run.stockSnapshot) && isNonEmptyString(run.versions.stockContractVersion) && run.stockSnapshot.contractVersion !== run.versions.stockContractVersion) {
    failures.push(`Run ${id} has mismatched stock contract evidence`)
  }
}

const validateConfiguration = (version, failures) => {
  const id = String(version._id)
  if (!isPositiveInteger(version.version)) failures.push(`Configuration ${id} has an invalid version`)
  if (!isLabel(version.vehicleCode)) failures.push(`Configuration ${id} has an invalid vehicle scope`)
  if (!isLabel(version.zoneCode)) failures.push(`Configuration ${id} has an invalid zone scope`)
  if (!isObject(version.period) || !isDate(version.period.from) || !isDate(version.period.to)) {
    failures.push(`Configuration ${id} has no validity period`)
  } else if (version.period.from.getTime() > version.period.to.getTime()) {
    failures.push(`Configuration ${id} has an inverted validity period`)
  }
  if (!isNumericRecord(version.values, true)) failures.push(`Configuration ${id} has invalid values`)
  if (!isNumericRecord(version.limits, false)) failures.push(`Configuration ${id} has invalid limits`)
  if (!isNonEmptyString(version.reason) || version.reason.length > 500) failures.push(`Configuration ${id} has no reason`)
  if (!isPersistedIdentifier(version.createdBy)) failures.push(`Configuration ${id} has no author`)
  if (!isPersistedIdentifier(version.approvedBy)) failures.push(`Configuration ${id} has no approver`)
  if (!isBoundedIdentifier(version.approvalId)) failures.push(`Configuration ${id} has no approval identifier`)
  if (!isDate(version.approvedAt)) failures.push(`Configuration ${id} has no approval timestamp`)
  if (!isStatus(version.status)) failures.push(`Configuration ${id} has an invalid status`)
}

const validatePreset = (preset, failures) => {
  const id = String(preset._id)
  if (!isLabel(preset.name)) failures.push(`Preset ${id} has an invalid name`)
  if (!isPositiveInteger(preset.version)) failures.push(`Preset ${id} has an invalid version`)
  if (!isObject(preset.definition) || !isValidOverrides(preset.definition.overrides) || !isValidDirectLoad(preset.definition.directLoad)) {
    failures.push(`Preset ${id} has an invalid definition`)
  }
  if (!isNonEmptyString(preset.reason) || preset.reason.length > 500) failures.push(`Preset ${id} has no reason`)
  if (!isPersistedIdentifier(preset.createdBy)) failures.push(`Preset ${id} has no author`)
  if (!isStatus(preset.status)) failures.push(`Preset ${id} has an invalid status`)
}

const verify = async (db) => {
  const existingCollections = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name))
  const failures = []
  const indexes = []

  for (const target of TARGETS) {
    if (!existingCollections.has(target.name)) {
      failures.push(`Missing collection ${target.name}`)
      continue
    }
    const observed = await db.collection(target.name).indexes()
    for (const expected of target.indexes) {
      const current = observed.find((index) => index.name === expected.name)
      if (current === undefined) {
        failures.push(`Missing index ${expected.name} on ${target.name}`)
        continue
      }
      if (!sameIndex(current, expected)) {
        failures.push(`Index ${expected.name} on ${target.name} does not match the expected definition`)
        continue
      }
      indexes.push({ collection: target.name, name: expected.name })
    }
  }

  const scanCollection = async (name, validate) => {
    if (!existingCollections.has(name)) return 0
    let checked = 0
    for await (const document of db.collection(name).find({})) {
      validate(document, failures)
      checked += 1
    }
    return checked
  }

  const runsChecked = await scanCollection('simulationruns', validateRun)
  const configurationsChecked = await scanCollection('simulationconfigversions', validateConfiguration)
  const presetsChecked = await scanCollection('simulationpresetversions', validatePreset)

  return {
    failures,
    indexes,
    runsChecked,
    configurationsChecked,
    presetsChecked,
    structuralValidationCheck: 'evaluated-by-migration',
    modelImmutabilityCheck: 'not-evaluated-by-migration'
  }
}

const runVerification = async (options) => {
  if (options.dryRun) {
    printArtifact('dry-run', options, {
      plannedActions: [
        'verify the three simulation collections exist',
        'verify every expected index exists with its exact key and uniqueness',
        'verify runs preserve structurally valid snapshots, inputs, results, actor, and versions',
        'verify configuration and preset versions preserve author, reason, scope, and definitions'
      ],
      businessDataMutated: false
    })
    return
  }

  const client = new MongoClient(options.uri, { serverSelectionTimeoutMS: 10000 })
  try {
    await client.connect()
    const result = await verify(client.db())
    const passed = result.failures.length === 0
    printArtifact(passed ? 'passed' : 'failed', options, {
      ...result,
      passed,
      businessDataMutated: false
    })
    if (!passed) throw new MigrationSafetyError(`Simulation verification failed: ${result.failures.join(', ')}`)
  } finally {
    await client.close()
  }
}

if (require.main === module) {
  runVerification(parseArguments(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Migration failed'}\n`)
    process.exitCode = 1
  })
}

module.exports = { validateRun, validateConfiguration, validatePreset, verify }
