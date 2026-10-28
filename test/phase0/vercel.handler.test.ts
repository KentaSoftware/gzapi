import { expect } from 'chai'
import sinon from 'sinon'
import type { Express, Request, Response } from 'express'
import { createVercelHandler } from '../../api/index'
import { getMongoUri } from '../../src/config/mongo'

interface TestResponse {
  statusCode: number
  body: unknown
  status: (code: number) => TestResponse
  json: (body: unknown) => TestResponse
}

const response = (): TestResponse => {
  const result: TestResponse = {
    statusCode: 200,
    body: undefined,
    status: (code: number) => {
      result.statusCode = code
      return result
    },
    json: (body: unknown) => {
      result.body = body
      return result
    }
  }
  return result
}

const request: Request = Object.create(null)

describe('Phase 0 — Vercel REST handler', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('S-08: caches application initialization for concurrent warm requests', async () => {
    let connectCalls = 0
    let seedCalls = 0
    let demoCalls = 0
    let appCalls = 0
    const app = ((_: Request, res: Response) => {
      res.status(200).json({ ok: true })
    }) as Express
    const handler = createVercelHandler({
      connect: async () => { connectCalls += 1 },
      seed: async () => { seedCalls += 1 },
      seedDemo: async () => { demoCalls += 1 },
      createApp: async () => {
        appCalls += 1
        await Promise.resolve()
        return app
      }
    })

    const first = response()
    const second = response()
    await Promise.all([
      handler(request, first as unknown as Response),
      handler(request, second as unknown as Response)
    ])

    expect(connectCalls).to.equal(1)
    expect(seedCalls).to.equal(1)
    expect(demoCalls).to.equal(1)
    expect(appCalls).to.equal(1)
    expect(first.statusCode).to.equal(200)
    expect(second.statusCode).to.equal(200)
  })

  it('S-09: returns a safe error and retries after initialization fails', async () => {
    let connectCalls = 0
    const secret = 'mongodb://private.example/secret'
    const error = new Error(`connection failed for ${secret}`)
    const app = ((_: Request, res: Response) => {
      res.status(200).json({ ok: true })
    }) as Express
    const handler = createVercelHandler({
      connect: async () => {
        connectCalls += 1
        if (connectCalls === 1) throw error
      },
      seed: async () => {},
      seedDemo: async () => {},
      createApp: async () => app
    })
    const log = sinon.stub(console, 'error')
    const failed = response()
    const retried = response()

    await handler(request, failed as unknown as Response)
    await handler(request, retried as unknown as Response)

    expect(failed.statusCode).to.equal(500)
    expect(failed.body).to.deep.equal({ error: 'Service initialization failed' })
    expect(retried.statusCode).to.equal(200)
    expect(connectCalls).to.equal(2)
    expect(log.calledWithMatch(secret)).to.equal(false)
  })

  it('does not serve login while demo preparation fails, and retries the full sequence', async () => {
    const order: string[] = []
    let attempts = 0
    const app = ((_: Request, res: Response) => {
      order.push('request')
      res.status(200).json({ ok: true })
    }) as Express
    const handler = createVercelHandler({
      connect: async () => { order.push('connect') },
      seed: async () => { order.push('base') },
      seedDemo: async () => {
        order.push('demo')
        attempts += 1
        if (attempts === 1) throw new Error('Offline DRIVE failure')
      },
      createApp: async () => { order.push('app'); return app }
    })
    const log = sinon.stub(console, 'error')
    const failed = response()
    await handler(request, failed as unknown as Response)
    expect(failed.statusCode).to.equal(500)
    expect(failed.body).to.deep.equal({ error: 'Service initialization failed' })
    expect(order).to.deep.equal(['connect', 'base', 'demo'])
    expect(log.calledWithMatch('DRIVE')).to.equal(false)

    const retried = response()
    await handler(request, retried as unknown as Response)
    expect(retried.statusCode).to.equal(200)
    expect(order).to.deep.equal(['connect', 'base', 'demo', 'connect', 'base', 'demo', 'app', 'request'])
  })
})

describe('Phase 0 — MongoDB configuration', () => {
  it('S-10: rejects missing and blank MongoDB URIs without exposing values', () => {
    const previous = process.env.MONGODB_URI
    try {
      for (const value of [undefined, '', '   ']) {
        if (value === undefined) delete process.env.MONGODB_URI
        else process.env.MONGODB_URI = value

        expect(() => getMongoUri()).to.throw('MONGODB_URI is required')
      }
    } finally {
      if (previous === undefined) delete process.env.MONGODB_URI
      else process.env.MONGODB_URI = previous
    }
  })

  it('S-10a: trims a configured MongoDB URI', () => {
    const previous = process.env.MONGODB_URI
    process.env.MONGODB_URI = '  mongodb://127.0.0.1:27017/gzapi  '
    try {
      expect(getMongoUri()).to.equal('mongodb://127.0.0.1:27017/gzapi')
    } finally {
      if (previous === undefined) delete process.env.MONGODB_URI
      else process.env.MONGODB_URI = previous
    }
  })
})
