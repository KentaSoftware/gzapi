/* eslint-disable @typescript-eslint/consistent-type-assertions */
import { expect } from 'chai'
import express from 'express'
import mongoose, { Types } from 'mongoose'
import sinon from 'sinon'
import request from 'supertest'
import ClientModel from '../../src/models/client'
import UserModel from '../../src/models/user'
import RoleModel from '../../src/models/role'
import * as jwt from '../../src/utils/jwt.handle'
import { router } from '../../src/routes/client'

describe('sale client options without a database', () => {
  let permissions: string[]
  let databaseUser: object | null
  let databaseRole: object | null
  let find: sinon.SinonStub
  let write: sinon.SinonStub
  let chain: { sort: sinon.SinonStub, limit: sinon.SinonStub, maxTimeMS: sinon.SinonStub, lean: sinon.SinonStub }
  const id = new Types.ObjectId()
  let app: express.Express

  beforeEach(() => {
    permissions = ['read_client']
    sinon.stub(mongoose.connection, '_readyState' as never).value(1)
    databaseUser = { isActive: true, role: id }
    databaseRole = { name: 'Employee', isActive: true }
    sinon.stub(jwt, 'verifyToken').resolves({ id: String(id), role: { permissions: ['read_client', 'create_sale'] } })
    sinon.stub(UserModel, 'findById').returns({ maxTimeMS: () => ({ lean: async () => databaseUser }) } as never)
    sinon.stub(RoleModel, 'findById').returns({ maxTimeMS: () => ({ lean: async () => databaseRole === null ? null : { ...databaseRole, permissions } }) } as never)
    chain = { sort: sinon.stub(), limit: sinon.stub(), maxTimeMS: sinon.stub(), lean: sinon.stub() }
    chain.sort.returns(chain)
    chain.limit.returns(chain)
    chain.maxTimeMS.returns(chain)
    chain.lean.resolves([{ _id: id, nombreCompleto: 'Alice', address: 'private' }])
    find = sinon.stub(ClientModel, 'find').returns(chain as never)
    write = sinon.stub(ClientModel, 'create')
    app = express().use('/client', router)
  })
  afterEach(() => { sinon.restore() })

  it('returns a bounded safe projection of active clients', async () => {
    const response = await request(app).get('/client/sale-options?q=Ali&limit=500').set('Authorization', 'Bearer token')
    expect(response.status).to.equal(200)
    expect(response.body).to.deep.equal({ clients: [{ id: String(id), name: 'Alice', address: 'private' }] })
    expect(find.firstCall.args[0]).to.include({ isActive: true })
    expect(find.firstCall.args[1]).to.deep.equal({ _id: 1, nombreCompleto: 1, address: 1 })
    expect(chain.sort.firstCall.args[0]).to.deep.equal({ nombreCompleto: 1, _id: 1 })
    expect(chain.limit.firstCall.args[0]).to.equal(20)
    expect(chain.maxTimeMS.firstCall.args[0]).to.equal(5000)
  })

  it('distinguishes same-name clients by address and omits missing addresses', async () => {
    const secondId = new Types.ObjectId()
    const thirdId = new Types.ObjectId()
    chain.lean.resolves([
      { _id: id, nombreCompleto: 'Alice', address: 'First Street', telefonos: [123] },
      { _id: secondId, nombreCompleto: 'Alice', address: 'Second Street' },
      { _id: thirdId, nombreCompleto: 'Alice', address: null }
    ])
    const response = await request(app).get('/client/sale-options?q=Alice').set('Authorization', 'Bearer token')
    expect(response.status).to.equal(200)
    expect(response.body).to.deep.equal({
      clients: [
        { id: String(id), name: 'Alice', address: 'First Street' },
        { id: String(secondId), name: 'Alice', address: 'Second Street' },
        { id: String(thirdId), name: 'Alice' }
      ]
    })
  })

  it('does not query for missing, empty or short terms', async () => {
    for (const query of ['', '?q=', '?q=a', '?q=%20%20']) {
      const response = await request(app).get(`/client/sale-options${query}`).set('Authorization', 'Bearer token')
      expect(response.status).to.equal(200)
      expect(response.body).to.deep.equal({ clients: [] })
    }
    expect(find.callCount).to.equal(0)
  })

  it('rejects long and non-string terms without database access', async () => {
    for (const query of [`?q=${'x'.repeat(101)}`, '?q%5B%24ne%5D=x', '?q=a&q=b']) {
      expect((await request(app).get(`/client/sale-options${query}`).set('Authorization', 'Bearer token')).status).to.equal(400)
    }
    expect(find.callCount).to.equal(0)
  })

  it('treats regex metacharacters as literal text', async () => {
    expect((await request(app).get('/client/sale-options').set('Authorization', 'Bearer token').query({ q: '.*(a+)' })).status).to.equal(200)
    const regex = find.firstCall.args[0].nombreCompleto as RegExp
    expect(regex.test('anything')).to.equal(false)
    expect(regex.test('.*(a+)')).to.equal(true)
  })

  it('allows sale-only users to use the bounded lookup but not general client reads or writes', async () => {
    permissions = ['create_sale']
    expect((await request(app).get('/client/sale-options?q=Alice').set('Authorization', 'Bearer token')).status).to.equal(200)
    expect(find.callCount).to.equal(1)
    expect((await request(app).get('/client').set('Authorization', 'Bearer token')).status).to.equal(403)
    expect((await request(app).post('/client').set('Authorization', 'Bearer token')).status).to.equal(403)
    expect(write.callCount).to.equal(0)
  })

  it('rejects missing or invalid credentials before looking up clients', async () => {
    expect((await request(app).get('/client/sale-options?q=Alice')).status).to.equal(401)
    ;(jwt.verifyToken as sinon.SinonStub).rejects(new Error('invalid token'))
    expect((await request(app).get('/client/sale-options?q=Alice').set('Authorization', 'Bearer invalid')).status).to.equal(401)
    expect(find.called).to.equal(false)
  })

  it('denies stale token grants and missing or inactive current users and roles', async () => {
    permissions = []
    expect((await request(app).get('/client/sale-options?q=Alice').set('Authorization', 'Bearer token')).status).to.equal(403)
    permissions = ['read_client']
    for (const user of [null, { isActive: false, role: id }, { isActive: true }]) {
      databaseUser = user
      expect((await request(app).get('/client/sale-options?q=Alice').set('Authorization', 'Bearer token')).status).to.equal(403)
    }
    databaseUser = { isActive: true, role: id }
    for (const role of [null, { name: 'Employee', isActive: false }]) {
      databaseRole = role
      expect((await request(app).get('/client/sale-options?q=Alice').set('Authorization', 'Bearer token')).status).to.equal(403)
    }
    expect(find.called).to.equal(false)
  })

  it('sanitizes database errors', async () => {
    chain.lean.rejects(new Error('secret database details'))
    const response = await request(app).get('/client/sale-options?q=Alice').set('Authorization', 'Bearer token')
    expect(response.status).to.equal(500)
    expect(JSON.stringify(response.body)).not.to.include('secret')
  })

  it('browses empty and one-character searches in bounded pages', async () => {
    for (const q of ['', 'a']) {
      const response = await request(app).get('/client/sale-options').query({ paged: 'true', q, limit: '2' }).set('Authorization', 'Bearer token')
      expect(response.status).to.equal(200)
      expect(response.body).to.deep.equal({ clients: [{ id: String(id), name: 'Alice', address: 'private' }], nextCursor: null })
      expect(find.lastCall.args[0].isActive).to.equal(true)
      expect(chain.limit.lastCall.args[0]).to.equal(3)
      expect(chain.maxTimeMS.lastCall.args[0]).to.equal(5000)
    }
  })

  it('continues after duplicate names with a stable id boundary', async () => {
    const second = new Types.ObjectId()
    chain.lean.resolves([{ _id: id, nombreCompleto: 'Alice' }, { _id: second, nombreCompleto: 'Alice' }])
    const first = await request(app).get('/client/sale-options?paged=true&limit=1&q=Al').set('Authorization', 'Bearer token')
    expect(first.body.clients).to.have.length(1)
    expect(first.body.nextCursor).to.be.a('string')
    chain.lean.resolves([{ _id: second, nombreCompleto: 'Alice' }])
    const next = await request(app).get('/client/sale-options').query({ paged: 'true', limit: '1', q: 'Al', cursor: first.body.nextCursor }).set('Authorization', 'Bearer token')
    expect(next.body).to.deep.equal({ clients: [{ id: String(second), name: 'Alice' }], nextCursor: null })
    expect(find.lastCall.args[0]._id).to.deep.equal({ $gt: id })
    expect(chain.sort.lastCall.args[0]).to.deep.equal({ _id: 1 })
    const changedSearch = await request(app).get('/client/sale-options').query({ paged: 'true', q: 'Bo', cursor: first.body.nextCursor }).set('Authorization', 'Bearer token')
    expect(changedSearch.status).to.equal(400)
    expect(find.callCount).to.equal(2)
  })

  it('rejects malformed paging parameters before querying', async () => {
    for (const query of ['?paged=no', '?paged=true&limit=0', '?paged=true&limit=101', '?paged=true&limit=1.5', '?paged=true&limit=2&limit=3', '?paged=true&cursor=bad', '?cursor=bad']) {
      expect((await request(app).get(`/client/sale-options${query}`).set('Authorization', 'Bearer token')).status, query).to.equal(400)
    }
    expect(find.called).to.equal(false)
  })

  it('uses escaped case-insensitive prefixes and enforces permissions in paged mode', async () => {
    permissions = ['create_sale']
    const result = await request(app).get('/client/sale-options').query({ paged: 'true', q: '.*' }).set('Authorization', 'Bearer token')
    expect(result.status).to.equal(200)
    const regex = find.lastCall.args[0].nombreCompleto as RegExp
    expect(regex.test('anything')).to.equal(false)
    expect(regex.test('.*Test')).to.equal(true)
    permissions = []
    expect((await request(app).get('/client/sale-options?paged=true').set('Authorization', 'Bearer token')).status).to.equal(403)
    expect(find.callCount).to.equal(1)
  })

  it('traverses realistic active fixtures by id without losing missing, duplicate or long names', async () => {
    interface Fixture { _id: Types.ObjectId, isActive?: boolean, nombreCompleto?: string | null, address?: string }
    interface Filter { isActive: boolean, nombreCompleto?: RegExp, _id?: { $gt: Types.ObjectId } }
    const fixtures: Fixture[] = Array.from({ length: 47 }, (_, index) => ({
      _id: new Types.ObjectId((index + 1).toString(16).padStart(24, '0')),
      isActive: index === 4 ? false : index === 5 ? undefined : true,
      ...(index === 19 || index === 20 ? {} : { nombreCompleto: index === 21 ? 'A'.repeat(3000) : index === 22 ? null : index === 23 ? ' ' : index % 2 === 0 ? 'Alice' : 'alice' }),
      ...(index === 21 ? { address: 'First Street' } : {})
    })).reverse()
    find.callsFake((filter: Filter, projection: object) => {
      expect(projection).to.deep.equal({ _id: 1, nombreCompleto: 1, address: 1 })
      let size = 0
      const fake = {
        sort: (sort: object) => { expect(sort).to.deep.equal({ _id: 1 }); return fake },
        limit: (limit: number) => { size = limit; return fake },
        maxTimeMS: (timeout: number) => { expect(timeout).to.equal(5000); return fake },
        lean: async () => fixtures.filter(item => item.isActive === filter.isActive &&
          (filter._id === undefined || String(item._id) > String(filter._id.$gt)) &&
          (filter.nombreCompleto === undefined || (typeof item.nombreCompleto === 'string' && filter.nombreCompleto.test(item.nombreCompleto))))
          .sort((a, b) => String(a._id).localeCompare(String(b._id))).slice(0, size)
      }
      return fake
    })
    for (const q of ['', 'a']) {
      const seen: Array<{ id: string, name: string, address?: string }> = []
      let cursor: string | null = null
      let pages = 0
      do {
        const response = await request(app).get('/client/sale-options').query({ paged: 'true', q, limit: '20', ...(cursor === null ? {} : { cursor }) }).set('Authorization', 'Bearer token')
        expect(response.status).to.equal(200)
        seen.push(...response.body.clients)
        cursor = response.body.nextCursor
        pages++
        expect(pages).to.be.lessThan(5)
      } while (cursor !== null)
      const expected = fixtures.filter(item => item.isActive === true && (q === '' || (item.nombreCompleto?.toLowerCase().startsWith(q) ?? false)))
        .sort((a, b) => String(a._id).localeCompare(String(b._id)))
        .map(item => ({ id: String(item._id), name: typeof item.nombreCompleto === 'string' && item.nombreCompleto.trim() !== '' ? item.nombreCompleto : 'Sin nombre', ...(item.address === undefined ? {} : { address: item.address }) }))
      expect(pages).to.be.greaterThan(1)
      expect(seen).to.deep.equal(expected)
      expect(new Set(seen.map(item => item.id)).size).to.equal(expected.length)
    }
  })
})
