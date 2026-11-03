import mongoose, { Schema } from 'mongoose'

import type {
  SimulationDemoProduct,
  SimulationDemoRoute,
  SimulationDemoScenario,
  SimulationDemoScenarioDetail
} from '../services/simulation'

const SIMULATION_DEMO_KEY = 'gzapi:simulation-demo:v1'

interface SimulationDemoCatalog {
  available: SimulationDemoProduct[]
  included: Array<SimulationDemoProduct & { quantity: number }>
}

interface SimulationDemoDocument {
  key: string
  routes: SimulationDemoRoute[]
  catalog: SimulationDemoCatalog
  scenarios: SimulationDemoScenario[]
  scenarioDetails?: Record<string, SimulationDemoScenarioDetail>
  nextScenarioNumber: number
}

interface SimulationDemoRepository {
  seed: (fixtures: Omit<SimulationDemoDocument, 'key' | 'nextScenarioNumber'>) => Promise<void>
  read: () => Promise<SimulationDemoDocument | null>
  allocateScenarioNumber: () => Promise<number>
  addScenario: (scenario: SimulationDemoScenario, detail: SimulationDemoScenarioDetail) => Promise<void>
}

interface SimulationDemoDriver {
  seed: (document: SimulationDemoDocument) => Promise<void>
  read: () => Promise<SimulationDemoDocument | null>
  allocateScenarioNumber: () => Promise<number>
  addScenario: (scenario: SimulationDemoScenario, detail: SimulationDemoScenarioDetail) => Promise<void>
}

const schema = new Schema<SimulationDemoDocument>({
  key: { type: String, required: true, unique: true },
  routes: { type: Schema.Types.Mixed, required: true },
  catalog: { type: Schema.Types.Mixed, required: true },
  scenarios: { type: Schema.Types.Mixed, required: true },
  scenarioDetails: { type: Schema.Types.Mixed, required: false },
  nextScenarioNumber: { type: Number, required: true }
}, { collection: 'simulationdemofixtures', versionKey: false })

const SimulationDemoFixtureModel = (mongoose.models.SimulationDemoFixture as mongoose.Model<SimulationDemoDocument> | undefined) ??
  mongoose.model<SimulationDemoDocument>('SimulationDemoFixture', schema)

const mongoDriver: SimulationDemoDriver = {
  seed: async (document) => {
    await SimulationDemoFixtureModel.updateOne({ key: SIMULATION_DEMO_KEY }, { $setOnInsert: document }, { upsert: true }).exec()
  },
  read: async () => await SimulationDemoFixtureModel.findOne({ key: SIMULATION_DEMO_KEY }).lean().exec(),
  allocateScenarioNumber: async () => {
    const fixture = await SimulationDemoFixtureModel.findOneAndUpdate(
      { key: SIMULATION_DEMO_KEY },
      [{
        $set: {
          nextScenarioNumber: {
            $add: [
              {
                $max: [
                  { $ifNull: ['$nextScenarioNumber', 15] },
                  {
                    $add: [
                      {
                        $max: {
                          $map: {
                            input: { $ifNull: ['$scenarios', []] },
                            as: 'scenario',
                            in: {
                              $convert: {
                                input: {
                                  $substrBytes: [
                                    '$$scenario.id',
                                    4,
                                    { $subtract: [{ $strLenBytes: '$$scenario.id' }, 4] }
                                  ]
                                },
                                to: 'int',
                                onError: 0,
                                onNull: 0
                              }
                            }
                          }
                        }
                      },
                      1
                    ]
                  }
                ]
              },
              1
            ]
          }
        }
      }],
      { new: true, projection: { nextScenarioNumber: 1 } }
    ).lean().exec()
    if (fixture === null) throw new Error('Simulation demo fixtures have not been seeded')
    return fixture.nextScenarioNumber - 1
  },
  addScenario: async (scenario, detail) => {
    await SimulationDemoFixtureModel.updateOne({ key: SIMULATION_DEMO_KEY }, {
      $push: { scenarios: { $each: [scenario], $position: 0 } },
      $set: { [`scenarioDetails.${scenario.id}`]: detail }
    }).exec()
  }
}

const createSimulationDemoRepository = (driver: SimulationDemoDriver = mongoDriver): SimulationDemoRepository => ({
  seed: async (fixtures) => await driver.seed({ ...fixtures, key: SIMULATION_DEMO_KEY, nextScenarioNumber: 15 }),
  read: async () => await driver.read(),
  allocateScenarioNumber: async () => await driver.allocateScenarioNumber(),
  addScenario: async (scenario, detail) => await driver.addScenario(scenario, detail)
})

const simulationDemoRepository = createSimulationDemoRepository()

const createInMemorySimulationDemoRepository = (): SimulationDemoRepository => {
  let document: SimulationDemoDocument | null = null
  return createSimulationDemoRepository({
    seed: async (seeded) => {
      if (document === null) document = structuredClone(seeded)
    },
    read: async () => document === null ? null : structuredClone(document),
    allocateScenarioNumber: async () => {
      if (document === null) throw new Error('Simulation demo fixtures have not been seeded')
      const highestExistingNumber = document.scenarios.reduce((highest, scenario) => {
        const parsed = Number.parseInt(scenario.id.slice(4), 10)
        return Math.max(highest, Number.isFinite(parsed) ? parsed : 0)
      }, 0)
      document.nextScenarioNumber = Math.max(document.nextScenarioNumber, highestExistingNumber + 1) + 1
      return document.nextScenarioNumber - 1
    },
    addScenario: async (scenario, detail) => {
      if (document === null) throw new Error('Simulation demo fixtures have not been seeded')
      document.scenarios.unshift(structuredClone(scenario))
      document.scenarioDetails ??= {}
      document.scenarioDetails[scenario.id] = structuredClone(detail)
    }
  })
}

export {
  createSimulationDemoRepository,
  createInMemorySimulationDemoRepository,
  simulationDemoRepository,
  SIMULATION_DEMO_KEY
}
export type {
  SimulationDemoCatalog,
  SimulationDemoDocument,
  SimulationDemoRepository,
  SimulationDemoDriver
}
