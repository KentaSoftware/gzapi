const { expect } = require('chai')
const sinon = require('sinon')
const net = require('net')

describe('Phase 0 — app factory', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('S-07: importing the app module opens no network listener', () => {
    const listenStub = sinon.stub(net.Server.prototype, 'listen')

    require('../../src/app')

    expect(listenStub.called).to.equal(false)
  })

  it('S-07a: createApp mounts routes and opens no listener in an isolated run', async () => {
    const listenStub = sinon.stub(net.Server.prototype, 'listen')

    const { createApp } = require('../../src/app')
    const app = await createApp()

    expect(listenStub.called).to.equal(false)

    listenStub.restore()

    const request = require('supertest')
    const res = await request(app).get('/ping')
    expect(res.status).to.equal(200)
    expect(res.text).to.equal('PING')
  })

  it('S-07b: createApp runs alongside another HTTP request without a shared listener', async () => {
    const listenStub = sinon.stub(net.Server.prototype, 'listen')

    const { createApp } = require('../../src/app')
    const appA = await createApp()
    const appB = await createApp()

    expect(listenStub.called).to.equal(false)

    listenStub.restore()

    const request = require('supertest')
    const [resA, resB] = await Promise.all([
      request(appA).get('/ping'),
      request(appB).get('/ping')
    ])

    expect(resA.status).to.equal(200)
    expect(resB.status).to.equal(200)
  })
})
