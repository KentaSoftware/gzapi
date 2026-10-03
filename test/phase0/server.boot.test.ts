const { expect } = require('chai')
const { spawn } = require('child_process')
const http = require('http')
const mongoose = require('mongoose')

const BOOT_PORT = 3199
const BOOT_DB_URI = 'mongodb://localhost:27017/gzapi_phase0_boot_test'

const waitForPing = (port, timeoutMs) => new Promise((resolve, reject) => {
  const startedAt = Date.now()
  const attempt = () => {
    const request = http.get({ host: '127.0.0.1', port, path: '/ping', timeout: 1000 }, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk.toString('utf8') })
      response.on('end', () => resolve({ status: response.statusCode, body }))
    })
    request.on('timeout', () => {
      request.destroy()
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`server did not answer /ping on port ${port} within ${timeoutMs}ms`))
        return
      }
      setTimeout(attempt, 250)
    })
    request.on('error', () => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`server did not boot on port ${port} within ${timeoutMs}ms`))
        return
      }
      setTimeout(attempt, 250)
    })
  }
  attempt()
})

describe('Phase 0 — server boot', () => {
  it('S-07c: running src/server.ts as the entry module boots the HTTP listener', async function () {
    this.timeout(30000)

    const child = spawn(process.execPath, ['-r', 'ts-node/register', 'src/server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TS_NODE_TRANSPILE_ONLY: '1',
        MONGODB_URI: BOOT_DB_URI,
        ADMIN_PASSWORD: 'phase0-boot-test-password',
        PORT: String(BOOT_PORT)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let childOutput = ''
    child.stdout.on('data', (chunk) => { childOutput += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { childOutput += chunk.toString('utf8') })

    try {
      const response = await waitForPing(BOOT_PORT, 20000)
      expect(response.status).to.equal(200)
      expect(response.body).to.equal('PING')
    } catch (error) {
      if (error instanceof Error) {
        error.message = `${error.message}\nchild output:\n${childOutput}`
      }
      throw error
    } finally {
      child.kill()
      await new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve()
          return
        }
        child.on('exit', resolve)
        child.kill()
      })
    }
  })

  after(async () => {
    await mongoose.connect(BOOT_DB_URI)
    const dbName = mongoose.connection.db && mongoose.connection.db.databaseName
    if (dbName && dbName.endsWith('_test')) {
      await mongoose.connection.dropDatabase()
    }
    await mongoose.disconnect()
  })
})
