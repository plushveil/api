import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ApiRequestError, ApiResponseError, createClient, interpolate, serializeQuery } from '../../src/client/main.ts'
import { createRouter, createServer, type Server } from '../../src/server/main.ts'
import type { Api } from '../fixtures/api-health/api.types.ts'

const API = new URL('../fixtures/api-health/api', import.meta.url).pathname

/**
 * The ad-hoc routes the error and middleware tests register.
 *
 * Declared rather than cast: an untyped client would force each call site to assert its own result
 * shape, which is the opposite of what these tests exist to check.
 */
interface TestApi {
  '/boom': {
    get: { responses: { 500: { error: string } } }
  }
  '/flaky': {
    get: { responses: { 200: { ok: boolean }; 401: Record<string, never> } }
  }
  '/echo': {
    get: { responses: { 200: Record<string, never> } }
  }
  '/gone': {
    get: { responses: { 200: Record<string, never> } }
  }
}

/**
 * Routes the client through a server's own `fetch`, so no socket is involved.
 */
function through(server: Server): typeof fetch {
  return (input, init) => server.fetch(new Request(input, init))
}

await describe('url building', async () => {
  await it('interpolates and percent-encodes path parameters', async () => {
    assert.equal(interpolate('/users/{id}', { id: 'Ada L' }), '/users/Ada%20L')
    assert.equal(interpolate('/users/{id}', { id: 'a/b' }), '/users/a%2Fb')
  })

  await it('encodes a catch-all segment by segment', async () => {
    assert.equal(interpolate('/files/{...rest}', { rest: 'a/b c' }), '/files/a/b%20c')
  })

  await it('fails before any I/O when a path parameter is missing', async () => {
    assert.throws(() => interpolate('/users/{id}', {}), ApiRequestError)
  })

  await it('serialises a query as form with explode, omitting undefined', async () => {
    assert.equal(serializeQuery({ a: 1, b: 'two' }), '?a=1&b=two')
    assert.equal(serializeQuery({ a: ['x', 'y'] }), '?a=x&a=y')
    assert.equal(serializeQuery({ a: undefined, b: null }), '')
    assert.equal(serializeQuery({}), '')
  })
})

await describe('client against the server', async () => {
  await it('calls a route with no options at all and narrows on status', async () => {
    const server = createServer({ routes: API })
    const client = createClient<Api>({ baseUrl: 'http://localhost', fetch: through(server) })

    const result = await client.get('/health')
    assert.equal(result.status, 200)
    if (result.status === 200) {
      assert.equal(result.body.status, 'ok')
      assert.equal(typeof result.body.uptime, 'number')
    }
    assert.equal(result.ok, true)
  })

  await it('sends a declared query parameter', async () => {
    const server = createServer({ routes: API })
    const client = createClient<Api>({ baseUrl: 'http://localhost', fetch: through(server) })

    const result = await client.get('/health', { query: { verbose: true } })
    assert.equal(result.status, 200)
    if (result.status === 200) assert.equal(result.body.region, 'local')
  })

  await it('works over a real socket', async () => {
    const server = createServer({ routes: API })
    const address = await server.listen(0, '127.0.0.1')
    try {
      const client = createClient<Api>({ baseUrl: `http://127.0.0.1:${address.port}` })
      const result = await client.get('/health')
      assert.equal(result.status, 200)
    } finally {
      await server.close()
    }
  })

  await it('leaves result.response unread so the caller can still use it', async () => {
    const server = createServer({ routes: API })
    const client = createClient<Api>({ baseUrl: 'http://localhost', fetch: through(server) })
    const result = await client.get('/health')
    assert.equal(result.response.bodyUsed, false)
    assert.ok((await result.response.text()).length > 0)
  })
})

await describe('errors and middleware', async () => {
  const failing = createRouter().add('get', '/boom', async () => ({ status: 500, body: { error: 'nope' } }))

  await it('does not throw for a non-2xx by default', async () => {
    const server = createServer({ routes: failing })
    const client = createClient<TestApi>({ baseUrl: 'http://localhost', fetch: through(server) })
    const result = await client.get('/boom')
    assert.equal(result.status, 500)
    assert.equal(result.ok, false)
  })

  await it('throws ApiResponseError with throwOnError', async () => {
    const server = createServer({ routes: failing })
    const client = createClient<TestApi>({ baseUrl: 'http://localhost', throwOnError: true, fetch: through(server) })
    await assert.rejects(
      () => client.get('/boom'),
      (error: unknown) => error instanceof ApiResponseError && error.status === 500,
    )
  })

  await it('wraps a transport failure in ApiRequestError', async () => {
    const client = createClient<TestApi>({
      baseUrl: 'http://localhost',
      fetch: () => Promise.reject(new Error('socket closed')),
    })
    await assert.rejects(() => client.get('/gone'), ApiRequestError)
  })

  await it('runs middleware outermost first and supports a retry', async () => {
    let attempts = 0
    const server = createServer({
      routes: createRouter().add('get', '/flaky', async () => {
        attempts++
        return attempts === 1 ? { status: 401, body: {} } : { status: 200, body: { ok: true } }
      }),
    })

    const client = createClient<TestApi>({ baseUrl: 'http://localhost', fetch: through(server) })
    client.use(async (request, next) => {
      const response = await next(request)
      // Calling next twice is a legitimate retry on the client, unlike on the server.
      return response.status === 401 ? next(request) : response
    })

    const result = await client.get('/flaky')
    assert.equal(attempts, 2)
    assert.equal(result.status, 200)
  })

  await it('applies default headers, including from a function', async () => {
    let seen: string | null = null
    const server = createServer({
      routes: createRouter().add('get', '/echo', async (_request, context) => {
        seen = context.request.headers.get('authorization')
        return { status: 200, body: {} }
      }),
    })
    const client = createClient<TestApi>({
      baseUrl: 'http://localhost',
      headers: () => ({ authorization: 'Bearer token' }),
      fetch: through(server),
    })
    await client.get('/echo')
    assert.equal(seen, 'Bearer token')
  })
})
