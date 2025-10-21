'use strict'

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const { setTimeout: sleep } = require('node:timers/promises')
const { request, Agent, setGlobalDispatcher, getGlobalDispatcher } = require('undici')
const createRateLimiterInterceptor = require('..')

const originalGlobalDispatcher = getGlobalDispatcher()
test.afterEach(() => setGlobalDispatcher(originalGlobalDispatcher))

test('Base - should allow request', async (t) => {
  const mainServer = http.createServer((req, res) => {
    res.writeHead(200)
    res.end()
  })

  mainServer.listen(0)

  t.after(() => {
    mainServer.close()
  })

  const dispatcher = new Agent().compose(createRateLimiterInterceptor())

  setGlobalDispatcher(dispatcher)

  const { statusCode } = await request(`http://localhost:${mainServer.address().port}`)
  assert.strictEqual(statusCode, 200)
})


test('Base - should throw error due to ratelimit threshold reached', async (t) => {
  const mainServer = http.createServer((req, res) => {
    res.writeHead(200)
    res.end()
  })

  mainServer.listen(0)

  t.after(() => {
    mainServer.close()
  })

  const dispatcher = new Agent().compose(createRateLimiterInterceptor({
        maxRequests: 1,
        windowMs: 500,
        identifier: () => 'default'
    }))

  setGlobalDispatcher(dispatcher)

  const { statusCode } = await request(`http://localhost:${mainServer.address().port}`)
  assert.strictEqual(statusCode, 200)


  await assert.rejects(async () => {
    await request(`http://localhost:${mainServer.address().port}`)
  }, (err) => {
    assert.equal(err.message, 'Rate limit exceeded: 1 requests per 500ms')
    return true
  })

  await sleep(1000)

  const { statusCode: statusCode2 } = await request(`http://localhost:${mainServer.address().port}`)
  assert.strictEqual(statusCode2, 200)
})