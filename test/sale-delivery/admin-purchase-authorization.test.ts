import express, { type Request, type Response } from 'express'
import { expect } from 'chai'
import { sign } from 'jsonwebtoken'
import mongoose from 'mongoose'
import proxyquire from 'proxyquire'
import sinon from 'sinon'
import request from 'supertest'
import UserModel from '../../src/models/user'
import RoleModel from '../../src/models/role'

describe('ordinary purchase route authorization', () => {
  const userId = '507f1f77bcf86cd799439011'
  const roleId = '507f1f77bcf86cd799439012'
  const originalState = mongoose.connection.readyState
  const secret = process.env.JWT_SECRET ?? 'NOT_TOKEN_ENV'
  let databaseUser: object | null
  let databaseRole: object | null
  let reached: string[]

  const controller = (name: string) => (_req: Request, res: Response): void => {
    reached.push(name)
    res.status(200).json({ handler: name })
  }
  const handlers = {
    getItems: controller('getItems'),
    getItem: controller('getItem'),
    postItem: controller('postItem'),
    updateItem: controller('updateItem'),
    getBuyStatsByUserController: controller('getBuyStatsByUserController'),
    getBuyStatsOverviewController: controller('getBuyStatsOverviewController'),
    createBuyExpense: controller('createBuyExpense'),
    listBuyExpenses: controller('listBuyExpenses'),
    '@noCallThru': true
  }
  const { router } = proxyquire('../../src/routes/buy', { '../controllers/buy': handlers }) as typeof import('../../src/routes/buy')
  const app = express()
  app.use(express.json())
  app.use('/buy', router)

  const token = (roleName = 'admin'): string => sign({ id: userId, role: { name: roleName, permissions: [] } }, secret)
  const routes = [
    { method: 'get', path: '/buy/', handler: 'getItems' },
    { method: 'post', path: '/buy/skip', handler: 'getItems' },
    { method: 'post', path: '/buy/search', handler: 'getItems' },
    { method: 'get', path: '/buy/123', handler: 'getItem' },
    { method: 'post', path: '/buy/', handler: 'postItem' },
    { method: 'patch', path: '/buy/123', handler: 'updateItem' },
    { method: 'post', path: '/buy/stats/by-user', handler: 'getBuyStatsByUserController' },
    { method: 'post', path: '/buy/stats/overview', handler: 'getBuyStatsOverviewController' },
    { method: 'post', path: '/buy/123/expenses', handler: 'createBuyExpense' },
    { method: 'get', path: '/buy/123/expenses', handler: 'listBuyExpenses' }
  ] as const

  before(() => { mongoose.connection.readyState = 1 })
  after(() => { mongoose.connection.readyState = originalState })
  beforeEach(() => {
    reached = []
    databaseUser = { isActive: true, role: roleId }
    databaseRole = { name: 'admin', isActive: true, permissions: [] }
    const userQuery: unknown = { maxTimeMS: () => ({ lean: async () => databaseUser }) }
    const roleQuery: unknown = { maxTimeMS: () => ({ lean: async () => databaseRole }) }
    sinon.stub(UserModel, 'findById').returns(userQuery as never)
    sinon.stub(RoleModel, 'findById').returns(roleQuery as never)
  })
  afterEach(() => { sinon.restore() })

  for (const route of routes) {
    it(`allows current admin with empty JWT permissions through ${route.method.toUpperCase()} ${route.path}`, async () => {
      const response = await request(app)[route.method](route.path).set('Authorization', `Bearer ${token()}`).send({})
      expect(response.status).to.equal(200)
      expect(response.body).to.deep.equal({ handler: route.handler })
      expect(reached).to.deep.equal([route.handler])
    })
  }

  for (const route of routes) {
    it(`denies unauthorized requests to ${route.method.toUpperCase()} ${route.path}`, async () => {
      const send = async (credential?: string): Promise<number> => {
        const call = request(app)[route.method](route.path).send({})
        if (credential !== undefined) void call.set('Authorization', `Bearer ${credential}`)
        return (await call).status
      }
      expect(await send()).to.equal(401)
      expect(await send('invalid.jwt.token')).to.equal(401)
      databaseUser = { isActive: false, role: roleId }
      expect(await send(token())).to.equal(403)
      databaseUser = { isActive: true, role: roleId }
      databaseRole = { name: 'admin', isActive: false, permissions: [] }
      expect(await send(token())).to.equal(403)
      databaseRole = { name: 'Employee', isActive: true, permissions: [] }
      expect(await send(token('Employee'))).to.equal(403)
      expect(reached).to.deep.equal([])
    })
  }
})
