import { strict as assert } from 'assert'
import proxyquire from 'proxyquire'

describe('server assignment index startup', () => {
  it('does not seed or listen when index initialization fails', async () => {
    const order: string[] = []
    const server = proxyquire('../../src/server', {
      './app': { createApp: async () => ({ listen: () => { order.push('listen') } }) },
      './config/mongo': { default: async () => { order.push('connect') } },
      './services/assignmentIndex': { initializeAssignmentIndex: async () => { order.push('index'); throw new Error('index failed') } },
      './services/seed': { seedDatabase: async () => { order.push('seed') } }
    }) as typeof import('../../src/server')
    await assert.rejects(server.startServer(), /index failed/)
    assert.deepEqual(order, ['connect', 'index'])
  })
})
