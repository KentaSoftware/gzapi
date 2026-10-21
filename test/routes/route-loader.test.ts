import { expect } from 'chai'
import request from 'supertest'

import { createApp } from '../../src/app'
import { routeRegistry } from '../../src/routes'

describe('route loader', () => {
  it('registers every route with its filename prefix', () => {
    expect(routeRegistry.map(({ prefix }) => prefix)).to.deep.equal([
      '/auth',
      '/backup',
      '/brand',
      '/buy',
      '/cashflow',
      '/catalog',
      '/categorie',
      '/city',
      '/client',
      '/commercialFact',
      '/dataset',
      '/deliveryZone',
      '/duplicateCheck',
      '/expense',
      '/finance',
      '/itemBuy',
      '/itemSale',
      '/log',
      '/ping',
      '/product',
      '/provider',
      '/role',
      '/routePlan',
      '/sale',
      '/stock',
      '/user'
    ])
  })

  it('mounts ping and auth login instead of returning 404', async () => {
    const app = await createApp()

    const pingResponse = await request(app).get('/ping')
    expect(pingResponse.status).to.equal(200)
    expect(pingResponse.text).to.equal('PING')

    const authRoute = routeRegistry.find(({ prefix }) => prefix === '/auth')
    expect(authRoute?.router.stack.some(({ route }) => {
      return route?.path === '/login' && route.methods.post === true
    })).to.equal(true)
  })
})
