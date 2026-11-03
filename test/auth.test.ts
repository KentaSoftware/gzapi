import { expect } from 'chai'
import sinon from 'sinon'

import { loginCtrl } from '../src/controllers/auth'
import * as authService from '../src/services/auth'

describe('Authentication request logging', () => {
  afterEach(() => sinon.restore())

  it('does not print the login password', async () => {
    const password = 'demo-login-secret-never-log'
    sinon.stub(authService, 'loginUser').resolves({ nickname: 'demo', token: 'token', nameRole: 'admin' })
    const log = sinon.stub(console, 'log')
    const response = {
      send: sinon.stub().returnsThis(),
      status: sinon.stub().returnsThis()
    }

    await loginCtrl({ body: { nickname: 'demo', password } } as never, response as never)

    expect(log.called).to.equal(false)
    expect(log.args.flat().join(' ')).to.not.contain(password)
  })
})
