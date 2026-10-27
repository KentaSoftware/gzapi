/**
 * PS-T14 — Contract between gzapi and the Document AI microservice.
 *
 * The fixtures in `test/fixtures/documents/` are real responses captured from
 * POST /analyze running the baseline OCR engine against two sample invoices.
 * If the microservice changes its response shape, these tests fail here.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const { expect } = require('chai')
const sinon = require('sinon')
const fs = require('fs')
const path = require('path')
const axios = require('axios')

const { analyzeDraftWithAI } = require('../src/services/purchaseDoc')

const FIXTURES = path.join(__dirname, 'fixtures', 'documents')
const ticket1 = require('./fixtures/documents/analyze-ticket1.json')
const ticket2 = require('./fixtures/documents/analyze-ticket2.json')

function makeDraft (): any {
  return {
    _id: '507f1f77bcf86cd799439011',
    providerId: '507f1f77bcf86cd799439022',
    userId: '507f1f77bcf86cd799439033',
    sourceType: 'INVOICE',
    file: {
      path: '../test/fixtures/documents/ticket1.jpeg',
      filename: 'ticket1.jpeg',
      mimeType: 'image/jpeg'
    }
  }
}

const { PassThrough } = require('stream')

/**
 * Avoids touching the filesystem: the upload is never read because axios is
 * stubbed, but form-data needs a real stream instance to build the multipart body.
 */
function stubFs (): void {
  sinon.stub(fs, 'existsSync').returns(true)
  sinon.stub(fs, 'createReadStream').callsFake(() => new PassThrough())
}

describe('PS-T14 — real fixtures captured from the microservice', () => {
  it('ticket1 fixture keeps its documented shape', () => {
    expect(ticket1).to.have.property('header')
    expect(ticket1).to.have.property('items')
    expect(ticket1.items).to.be.an('array').with.length.greaterThan(0)
    expect(ticket1.header.total).to.have.property('value')
    expect(ticket1.header.provider).to.have.property('taxId')
    expect(ticket1.items[0]).to.have.property('lineId')
    expect(ticket1.items[0]).to.have.property('quantity')
    expect(ticket1.items[0]).to.have.property('catalogLink')
  })

  it('ticket2 fixture keeps its documented shape', () => {
    expect(ticket2.items).to.be.an('array').with.length.greaterThan(1)
    expect(ticket2.header.provider.name).to.be.a('string')
    expect(ticket2.header.documentNumber.value).to.be.a('string')
  })

  it('both fixtures exist on disk so they can be versioned', () => {
    expect(fs.existsSync(path.join(FIXTURES, 'analyze-ticket1.json'))).to.equal(true)
    expect(fs.existsSync(path.join(FIXTURES, 'analyze-ticket2.json'))).to.equal(true)
  })
})

describe('PS-T14 — analyzeDraftWithAI contract', () => {
  afterEach(() => sinon.restore())

  it('parses a real microservice response', async () => {
    stubFs()
    sinon.stub(axios, 'post').resolves({ data: ticket1 } as any)

    const result = await analyzeDraftWithAI(makeDraft(), 'Bearer test')

    expect(result).to.be.an('object')
    expect(result.header).to.be.an('object')
    expect((result as any).header.total).to.equal(ticket1.header.total.value)
    expect((result as any).items).to.have.length(ticket1.items.length)
  })

  it('parses the second fixture without losing items', async () => {
    stubFs()
    sinon.stub(axios, 'post').resolves({ data: ticket2 } as any)

    const result = await analyzeDraftWithAI(makeDraft(), 'Bearer test')

    expect((result as any).items).to.have.length(ticket2.items.length)
  })

  it('retries three times and fails on a server error', async () => {
    stubFs()
    const axiosError: any = new Error('Request failed with status code 500')
    axiosError.isAxiosError = true
    axiosError.response = { status: 500, statusText: 'Internal Server Error', data: { detail: 'boom' } }

    const post = sinon.stub(axios, 'post').rejects(axiosError)
    sinon.stub(axios, 'isAxiosError').returns(true)

    const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      let captured: any = null
      const promise = analyzeDraftWithAI(makeDraft(), 'Bearer test').catch((error: any) => {
        captured = error
      })

      await clock.tickAsync(10000)
      await promise

      expect(post.callCount).to.equal(3)
      expect(captured).to.be.instanceOf(Error)
      expect(captured.message).to.match(/Document AI no responde/)
    } finally {
      clock.restore()
    }
  })

  it('retries on timeout and fails after three attempts', async () => {
    stubFs()
    const timeoutError: any = new Error('timeout of 240000ms exceeded')
    timeoutError.isAxiosError = true
    timeoutError.code = 'ECONNABORTED'

    const post = sinon.stub(axios, 'post').rejects(timeoutError)
    sinon.stub(axios, 'isAxiosError').returns(true)

    const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      let captured: any = null
      const promise = analyzeDraftWithAI(makeDraft(), 'Bearer test').catch((error: any) => {
        captured = error
      })

      await clock.tickAsync(10000)
      await promise

      expect(post.callCount).to.equal(3)
      expect(captured).to.be.instanceOf(Error)
    } finally {
      clock.restore()
    }
  })

  it('rejects a non-JSON body instead of degrading, after three attempts', async () => {
    stubFs()
    const post = sinon.stub(axios, 'post').resolves({ data: '<html>Bad Gateway</html>' } as any)

    const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      let captured: any = null
      const promise = analyzeDraftWithAI(makeDraft(), 'Bearer test').catch((error: any) => {
        captured = error
      })

      await clock.tickAsync(10000)
      await promise

      expect(post.callCount).to.equal(3)
      expect(captured).to.be.instanceOf(Error)
      expect(captured.message).to.match(/respuesta inválida/i)
    } finally {
      clock.restore()
    }
  })

  it('rejects a JSON body that is not an analysis', async () => {
    stubFs()
    sinon.stub(axios, 'post').resolves({ data: { detail: 'proxy error' } } as any)

    const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      let captured: any = null
      const promise = analyzeDraftWithAI(makeDraft(), 'Bearer test').catch((error: any) => {
        captured = error
      })

      await clock.tickAsync(10000)
      await promise

      expect(captured).to.be.instanceOf(Error)
      expect(captured.message).to.match(/respuesta inválida/i)
    } finally {
      clock.restore()
    }
  })
})
