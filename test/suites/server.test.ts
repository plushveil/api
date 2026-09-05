import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compareRoutes, createRouter, createServer, HttpError, matchSegments, parsePattern, type Context, type Middleware, type Route } from '../../src/server/main.ts'
import { readJson, records } from '../helpers/json.ts'

const API = new URL('../fixtures/api-health/api', import.meta.url).pathname

function route(pattern: string, method = 'GET'): Route {
  return { method, pattern, path: pattern, segments: parsePattern(pattern), middleware: [] }
}

await describe('route matching', async () => {
  await it('prefers a static segment over a parameter, whatever the registration order', async () => {
    const router = createRouter()
    router.add('get', '/users/{userId}', async () => ({ status: 200, body: 'param' }))
    router.add('get', '/users/me', async () => ({ status: 200, body: 'static' }))

    assert.equal(router.match('GET', '/users/me')?.route.pattern, '/users/me')
    assert.equal(router.match('GET', '/users/42')?.route.pattern, '/users/{userId}')
  })

  await it('orders a catch-all last', async () => {
    const sorted = [route('/files/{...rest}'), route('/files/{name}'), route('/files/readme')].sort(compareRoutes)
    assert.deepEqual(
      sorted.map((r) => r.pattern),
      ['/files/readme', '/files/{name}', '/files/{...rest}'],
    )
  })

  await it('is antisymmetric and transitive across every shape up to three segments', async () => {
    // The real proof of the comparator, and cheap enough to run every time.
    const kinds = ['a', '{p}', '{...r}']
    const patterns: string[] = []
    for (let length = 1; length <= 3; length++) {
      const build = (prefix: string[]): void => {
        if (prefix.length === length) {
          // A catch-all is only legal as the final segment.
          if (prefix.findIndex((s) => s.startsWith('{...')) === -1 || prefix.findIndex((s) => s.startsWith('{...')) === length - 1) {
            patterns.push(`/${prefix.join('/')}`)
          }
          return
        }
        for (const kind of kinds) build([...prefix, kind])
      }
      build([])
    }

    const routes = patterns.map((p) => route(p))
    for (const a of routes) {
      for (const b of routes) {
        // `+ 0` normalises -0, which is not strictly equal to 0.
        assert.equal(Math.sign(compareRoutes(a, b)) + Math.sign(compareRoutes(b, a)), 0, `antisymmetry: ${a.pattern} vs ${b.pattern}`)
        for (const c of routes) {
          if (compareRoutes(a, b) < 0 && compareRoutes(b, c) < 0) {
            assert.ok(compareRoutes(a, c) < 0, `transitivity: ${a.pattern} < ${b.pattern} < ${c.pattern}`)
          }
        }
      }
    }
  })

  await it('makes a catch-all consume one or more segments', async () => {
    const segments = parsePattern('/files/{...rest}')
    assert.deepEqual(matchSegments(segments, ['files', 'a', 'b']), { rest: 'a/b' })
    assert.deepEqual(matchSegments(segments, ['files', 'a']), { rest: 'a' })
    assert.equal(matchSegments(segments, ['files']), undefined)
  })

  await it('percent-decodes captured parameters', async () => {
    // `new URL(...).pathname` does not decode, so without this the client and server disagree.
    assert.deepEqual(matchSegments(parsePattern('/u/{name}'), ['u', 'Ada%20L']), { name: 'Ada L' })
  })
})

await describe('middleware', async () => {
  await it('runs as an onion, outermost first', async () => {
    const order: string[] = []
    const outer: Middleware = async (_context, next) => {
      order.push('outer:before')
      await next()
      order.push('outer:after')
    }
    const inner: Middleware = async (_context, next) => {
      order.push('inner:before')
      await next()
      order.push('inner:after')
    }

    const server = createServer({ routes: createRouter().add('get', '/x', async () => ({ status: 200, body: 'ok' })), middleware: [outer, inner] })
    await server.fetch(new Request('http://localhost/x'))

    assert.deepEqual(order, ['outer:before', 'inner:before', 'inner:after', 'outer:after'])
  })

  await it('short-circuits when next is not called', async () => {
    const guard: Middleware = async (context) => {
      context.response.status = 401
      context.response.body = { type: 'error', error: { code: 401, message: 'Unauthorized' } }
    }
    const server = createServer({ routes: createRouter().add('get', '/x', async () => ({ status: 200, body: 'reached' })), middleware: [guard] })
    const response = await server.fetch(new Request('http://localhost/x'))
    assert.equal(response.status, 401)
  })

  await it('can set a response header after the handler ran', async () => {
    const stamp: Middleware = async (context, next) => {
      await next()
      context.response.headers.set('x-stamp', 'yes')
    }
    const server = createServer({ routes: createRouter().add('get', '/x', async () => ({ status: 200, body: 'ok' })), middleware: [stamp] })
    const response = await server.fetch(new Request('http://localhost/x'))
    assert.equal(response.headers.get('x-stamp'), 'yes')
  })
})

await describe('createServer', async () => {
  await it('serves the api/ fixture through fetch', async () => {
    const server = createServer({ routes: API })
    const response = await server.fetch(new Request('http://localhost/health'))
    assert.equal(response.status, 200)
    const body = await readJson(response)
    assert.equal(body.status, 'ok')
    assert.equal(typeof body.uptime, 'number')
  })

  await it('serves the same route over a real socket', async () => {
    // Proves the node adapter and `fetch` share one code path rather than two.
    const server = createServer({ routes: API })
    const address = await server.listen(0, '127.0.0.1')
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/health`)
      assert.equal(response.status, 200)
      assert.equal((await readJson(response)).status, 'ok')
    } finally {
      await server.close()
    }
  })

  await it('reads a POST body over a real socket, not just through fetch', async () => {
    // The Node adapter hands the handler the raw `IncomingMessage` as well as the constructed
    // `Request`; the body must still come from the latter, or every real request loses its body.
    const router = createRouter().add('post', '/echo', async ({ body }) => ({ status: 200, body }))
    const server = createServer({ routes: router })
    const address = await server.listen(0, '127.0.0.1')
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      })
      assert.equal(response.status, 200)
      assert.deepEqual(await readJson(response), { hello: 'world' })
    } finally {
      await server.close()
    }
  })

  await it('answers 404 for an unmatched request', async () => {
    const server = createServer({ routes: API })
    assert.equal((await server.fetch(new Request('http://localhost/nope'))).status, 404)
  })

  await it('surfaces a thrown HttpError with its status and body', async () => {
    const router = createRouter().add('get', '/boom', async () => {
      throw new HttpError(409, { code: 'conflict', message: 'That email is taken.' })
    })
    const server = createServer({ routes: router })
    const response = await server.fetch(new Request('http://localhost/boom'))
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { code: 'conflict', message: 'That email is taken.' })
  })

  await it('hides an unexpected error behind a 500', async () => {
    const router = createRouter().add('get', '/boom', async () => {
      throw new Error('a secret detail')
    })
    const server = createServer({ routes: router, onError: () => ({ status: 500, body: { error: 'internal' } }) })
    const response = await server.fetch(new Request('http://localhost/boom'))
    assert.equal(response.status, 500)
    assert.equal(JSON.stringify(await response.json()).includes('secret'), false)
  })

  await it('sends no body for a status that forbids one', async () => {
    // `new Response('x', { status: 205 })` throws, so this must not reach the constructor.
    const router = createRouter().add('get', '/empty', async () => ({ status: 205 }))
    const server = createServer({ routes: router })
    const response = await server.fetch(new Request('http://localhost/empty'))
    assert.equal(response.status, 205)
    assert.equal(await response.text(), '')
  })

  await it('validates against a spec and reports every problem', async () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/items': {
          get: {
            parameters: [{ name: 'page', in: 'query' as const, required: true, schema: { type: 'integer' as const, minimum: 1 } }],
            responses: { 200: { description: 'OK' } },
          },
        },
      },
    }
    const router = createRouter().add('get', '/items', async (_request, context: Context) => ({ status: 200, body: { page: context.request.query.page } }))
    const server = createServer({ routes: router, spec, validate: true })

    const bad = await server.fetch(new Request('http://localhost/items?page=0'))
    assert.equal(bad.status, 400)
    const problem = await readJson(bad)
    assert.equal(problem.error, 'validation_failed')
    assert.equal(records(problem, 'problems')[0]?.in, 'query')

    const missing = await server.fetch(new Request('http://localhost/items'))
    assert.equal(missing.status, 400)

    // Coercion is what makes a declared integer actually be one in the handler.
    const good = await server.fetch(new Request('http://localhost/items?page=3'))
    assert.equal(good.status, 200)
    assert.deepEqual(await good.json(), { page: 3 })
  })
})

await describe('body reading', async () => {
  await it('parses a form-urlencoded body', async () => {
    const router = createRouter().add('post', '/form', async ({ body }) => ({ status: 200, body }))
    const server = createServer({ routes: router })
    const response = await server.fetch(new Request('http://localhost/form', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1&a=2&b=3' }))
    assert.equal(response.status, 200)
    assert.deepEqual(await readJson(response), { a: ['1', '2'], b: '3' })
  })

  await it('returns undefined for an empty body, not an empty string', async () => {
    const router = createRouter().add('post', '/empty', async ({ body }) => ({ status: 200, body: { isUndefined: body === undefined } }))
    const server = createServer({ routes: router })
    const response = await server.fetch(new Request('http://localhost/empty', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '' }))
    assert.deepEqual(await readJson(response), { isUndefined: true })
  })

  await it('413s a body over bodyLimit', async () => {
    const router = createRouter().add('post', '/big', async ({ body }) => ({ status: 200, body }))
    const server = createServer({ routes: router, bodyLimit: 10 })
    const response = await server.fetch(new Request('http://localhost/big', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'x'.repeat(100) }) }))
    assert.equal(response.status, 413)
  })

  await it('reads a text/plain body as a string', async () => {
    const router = createRouter().add('post', '/text', async ({ body }) => ({ status: 200, body: { type: typeof body, value: body } }))
    const server = createServer({ routes: router })
    const response = await server.fetch(new Request('http://localhost/text', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello' }))
    assert.deepEqual(await readJson(response), { type: 'string', value: 'hello' })
  })

  await it('buffers an undeclared binary body as Uint8Array, not corrupted UTF-8 text', async () => {
    // A lone continuation byte is invalid UTF-8: decoding it as text would silently replace it with
    // U+FFFD. A `Uint8Array` must round-trip the exact bytes instead.
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x80])
    const router = createRouter().add('post', '/bytes', async ({ body }) => ({ status: 200, body: { bytes: body instanceof Uint8Array ? Array.from(body) : null } }))
    const server = createServer({ routes: router })
    const response = await server.fetch(new Request('http://localhost/bytes', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes }))
    assert.deepEqual(await readJson(response), { bytes: Array.from(bytes) })
  })

  await it('hands a declared streaming body to the handler as a ReadableStream, unbuffered', async () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/upload': {
          put: {
            requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string' as const, format: 'binary' }, 'x-stream': true } } },
            responses: { 200: { description: 'OK' } },
          },
        },
      },
    }
    const router = createRouter().add('put', '/upload', async ({ body }) => {
      if (!(body instanceof ReadableStream)) return { status: 500, body: { error: 'not a stream' } }
      let total = 0
      const reader = body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
      }
      return { status: 200, body: { total } }
    })
    const server = createServer({ routes: router, spec, validate: true })
    const response = await server.fetch(new Request('http://localhost/upload', { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(1024) }))
    assert.equal(response.status, 200)
    assert.deepEqual(await readJson(response), { total: 1024 })
  })

  await it('415s a body whose content-type the operation does not declare', async () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/typed': {
          post: {
            requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' as const } } } },
            responses: { 200: { description: 'OK' } },
          },
        },
      },
    }
    const router = createRouter().add('post', '/typed', async ({ body }) => ({ status: 200, body }))
    const server = createServer({ routes: router, spec, validate: true })
    const response = await server.fetch(new Request('http://localhost/typed', { method: 'POST', headers: { 'content-type': 'text/csv' }, body: 'a,b\n1,2' }))
    assert.equal(response.status, 415)
  })
})
