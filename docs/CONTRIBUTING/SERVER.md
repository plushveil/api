# API

## Server

```ts
import { createServer } from '@plushveil/api/server'
```

`@plushveil/api/server` starts an HTTP server, routes requests to route modules, and runs
middleware. It is built on `node:http` and has no dependencies. It does not read your
TypeScript types — those are gone by the time the process runs — so request validation is
driven by a generated `openapi.json`. See [ARCHITECTURE.md](./ARCHITECTURE.md).

The `Handler` and `Content` types are exported from here but documented alongside the route
modules that use them, in [API_FOLDER.md](./API_FOLDER.md).

## `createServer(options)`

```ts
const server = createServer({
  routes: './api',
  spec: './openapi.json',
  validate: true,
})

await server.listen(3000)
```

### Options

| Option       | Type                                                | Default   | Description                                                                                                                                                                                                                                                                                                            |
| ------------ | --------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routes`     | `string \| Router`                                  | `'./api'` | An `api/` folder to load, or a router you built yourself.                                                                                                                                                                                                                                                              |
| `spec`       | `string \| object`                                  | —         | Path to an `openapi.json`, or the parsed document. Required for validation.                                                                                                                                                                                                                                            |
| `validate`   | `boolean \| ValidateOptions`                        | `false`   | Validate requests, and optionally responses, against `spec`.                                                                                                                                                                                                                                                           |
| `basePath`   | `string`                                            | `'/'`     | Prefix stripped before matching and prepended in the spec.                                                                                                                                                                                                                                                             |
| `middleware` | `Middleware[]`                                      | `[]`      | Middleware to register before the loaded routes' own.                                                                                                                                                                                                                                                                  |
| `onError`    | `(error, context) => Response \| Promise<Response>` | built-in  | Converts a thrown error into a response.                                                                                                                                                                                                                                                                               |
| `notFound`   | `Handler`                                           | built-in  | Handles unmatched requests. Defaults to `404`.                                                                                                                                                                                                                                                                         |
| `bodyLimit`  | `number`                                            | `1048576` | Maximum buffered request body size in bytes. Exceeding it is `413`, checked from `content-length` when present and incrementally otherwise. Does not apply to a body declared `Content<M, ReadableStream<Uint8Array>>` -- see [Media Types](./API_FOLDER.md#media-types) -- which is handed to the handler unbuffered. |
| `trustProxy` | `boolean`                                           | `false`   | Honour `x-forwarded-*` when deriving `context.request.url`.                                                                                                                                                                                                                                                            |
| `server`     | `http.Server`                                       | —         | An existing server to attach to instead of creating one.                                                                                                                                                                                                                                                               |

### Returns

| Member                     | Type                   | Description                                                                                        |
| -------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------- |
| `listen(port?, hostname?)` | `Promise<AddressInfo>` | Starts listening. Resolves with the bound address; pass `0` for an ephemeral port.                 |
| `close()`                  | `Promise<void>`        | Stops listening and waits for in-flight requests to finish.                                        |
| `use(middleware)`          | `this`                 | Registers middleware. Chainable.                                                                   |
| `router`                   | `Router`               | The router in use.                                                                                 |
| `fetch(request)`           | `Promise<Response>`    | Handles a `Request` and returns a `Response`, without any socket. This is the testing entry point. |
| `http`                     | `http.Server`          | The underlying server.                                                                             |

`fetch` is the same code path a real request takes, so tests need no port:

```ts
const server = createServer({ routes: './api' })
const response = await server.fetch(new Request('http://localhost/health'))

assert.equal(response.status, 200)
```

## Validation

```ts
createServer({
  spec: './openapi.json',
  validate: { request: true, response: 'warn', coerce: true },
})
```

| Option     | Type                | Default | Description                                                                      |
| ---------- | ------------------- | ------- | -------------------------------------------------------------------------------- |
| `request`  | `boolean`           | `true`  | Validate path and query parameters, headers, and the body. A failure is `400`.   |
| `response` | `boolean \| 'warn'` | `false` | Validate handler output. A failure is `500`, or a warning when `'warn'`.         |
| `coerce`   | `boolean`           | `true`  | Coerce parameters from strings to their declared type. Bodies are never coerced. |

`validate: true` is shorthand for the defaults above. Parameters arrive as strings, so
`coerce` is what makes a `query: { page?: number }` actually be a number in your handler; with
it off, a numeric parameter that arrives as a string is a validation failure.

A validation failure produces a `400` whose body lists every problem:

```json
{
  "error": "validation_failed",
  "message": "The request does not match the specification.",
  "problems": [
    { "in": "query", "path": "/page", "message": "must be integer" },
    { "in": "body", "path": "/email", "message": "must match format \"email\"" }
  ]
}
```

Operations are matched to the spec by path and method. A route with no corresponding operation
in the spec is served unvalidated and warned about at startup, unless `validate.request` is
`'strict'`, which makes it a startup error.

## Middleware

Middleware is an onion: each layer receives the context and a `next` function, and may act
before, after, or instead of the layers within.

```ts
import type { Middleware } from '@plushveil/api/server'

export const timing: Middleware = async (context, next) => {
  const start = process.hrtime.bigint()
  await next()
  const ms = Number(process.hrtime.bigint() - start) / 1e6
  context.response.headers.set('server-timing', `total;dur=${ms}`)
}
```

Not calling `next()` short-circuits: the handler and everything below never run.

### Registration

Three ways, applied in this order:

1. `createServer({ middleware: [...] })` — before everything.
2. `server.use(mw)` / `router.use(mw)` — in call order.
3. A `middleware.ts` file in the `api/` folder — see below.

### `middleware.ts`

A `middleware.ts` file applies to its folder and every folder below it. Outer folders run
first.

```ts
// api/users/middleware.ts
import type { Middleware } from '@plushveil/api/server'

export default [requireAuth, rateLimit] satisfies Middleware[]
```

The default export is one `Middleware` or an array of them. For a request to
`get /users/{userId}`, `api/middleware.ts` runs, then `api/users/middleware.ts`, then the
handler.

## Context

Every middleware and handler receives the same `Context` for a request.

| Member             | Type                         | Description                                                                                                                                                                                                                                                                                                    |
| ------------------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request.method`   | `string`                     | Uppercase.                                                                                                                                                                                                                                                                                                     |
| `request.url`      | `URL`                        | Absolute, honouring `trustProxy`.                                                                                                                                                                                                                                                                              |
| `request.path`     | `Record<string, string>`     | Path parameters, coerced when `validate.coerce` is on.                                                                                                                                                                                                                                                         |
| `request.query`    | `Record<string, unknown>`    | Parsed query, coerced when `validate.coerce` is on.                                                                                                                                                                                                                                                            |
| `request.headers`  | `Headers`                    | Case-insensitive.                                                                                                                                                                                                                                                                                              |
| `request.cookies`  | `Map<string, string>`        | Parsed from `cookie`.                                                                                                                                                                                                                                                                                          |
| `request.body`     | `unknown`                    | Parsed per content type: JSON, form-urlencoded, `text/*` as a string, anything else as a buffered `Uint8Array` -- or, when a matched operation declares it with `Content<M, ReadableStream<Uint8Array>>`, the unbuffered stream itself. `undefined` until read, and for a method with no body (`GET`, `HEAD`). |
| `request.raw`      | `http.IncomingMessage`       | The unparsed stream, for when you need it.                                                                                                                                                                                                                                                                     |
| `response.status`  | `number`                     | Mutable.                                                                                                                                                                                                                                                                                                       |
| `response.headers` | `Headers`                    | Mutable.                                                                                                                                                                                                                                                                                                       |
| `response.body`    | `unknown`                    | Set by the handler; mutable afterwards.                                                                                                                                                                                                                                                                        |
| `state`            | `Record<string, unknown>`    | Per-request scratch space for passing values between middleware.                                                                                                                                                                                                                                               |
| `operation`        | `OperationInfo \| undefined` | The matched route's `method`, `path`, `operationId`, and file. Undefined when nothing matched.                                                                                                                                                                                                                 |
| `signal`           | `AbortSignal`                | Aborts when the client disconnects.                                                                                                                                                                                                                                                                            |

To type `state` across your own middleware, declare it once:

```ts
declare module '@plushveil/api/server' {
  interface State {
    user: User
  }
}
```

`context.state.user` is then typed everywhere.

## Router

Use the router directly when you need routes the filesystem convention cannot express, or want
to mount one API inside another.

```ts
import { createRouter, loadRoutes } from '@plushveil/api/server'

const router = createRouter()
router.use(timing)
router.add('get', '/version', async () => ({ status: 200, body: { version: '1.0.0' } }))
router.mount('/v1', await loadRoutes('./api'))

createServer({ routes: router })
```

| Member                       | Description                                                          |
| ---------------------------- | -------------------------------------------------------------------- |
| `use(middleware)`            | Registers middleware for this router. Chainable.                     |
| `add(method, path, handler)` | Registers one route. `path` uses `{param}` syntax. Chainable.        |
| `mount(prefix, router)`      | Nests a router under a prefix. Chainable.                            |
| `match(method, pathname)`    | Returns the matching route and extracted parameters, or `undefined`. |
| `handle(context)`            | Runs the middleware chain and handler for a context.                 |
| `routes`                     | The registered routes, sorted by specificity.                        |

Static segments beat parameters, which beat catch-alls. `/users/me` wins over `/users/{userId}`
regardless of registration order.

### `loadRoutes(dir, options?)`

Scans an `api/` folder and returns a `Router`. Called for you by `createServer` when `routes`
is a string.

| Option     | Type       | Default                        | Description                                                                          |
| ---------- | ---------- | ------------------------------ | ------------------------------------------------------------------------------------ |
| `basePath` | `string`   | `'/'`                          | Prefix for every route.                                                              |
| `ignore`   | `string[]` | `['**/*.test.ts', '**/_*.ts']` | Glob patterns to skip.                                                               |
| `eager`    | `boolean`  | `true`                         | Import every module at startup. When `false`, modules are imported on first request. |

`eager: true` surfaces a broken route module at startup rather than on the request that hits
it. Use `false` only when startup time matters more than that.

## Errors

Throw `HttpError` for a deliberate failure:

```ts
import { HttpError } from '@plushveil/api/server'

throw new HttpError(409, { code: 'conflict', message: 'That email is taken.' })
```

| Class                       | Extends     | Status | Thrown when                                                                |
| --------------------------- | ----------- | ------ | -------------------------------------------------------------------------- |
| `HttpError`                 | `Error`     | yours  | You throw it.                                                              |
| `ValidationError`           | `HttpError` | `400`  | A request fails validation. Carries `problems`.                            |
| `UnsupportedMediaTypeError` | `HttpError` | `415`  | A request body's `content-type` is not one the matched operation declares. |
| `ResponseValidationError`   | `HttpError` | `500`  | A response fails validation. Carries `problems`.                           |
| `RouteError`                | `Error`     | —      | A route module is malformed. Thrown at load time, never per request.       |

Any other thrown value becomes a `500` with no detail in the body, and is logged. Override
with `onError`:

```ts
createServer({
  onError: (error, context) => {
    if (error instanceof HttpError) return { status: error.status, body: error.body }
    report(error, { operationId: context.operation?.operationId })
    return { status: 500, body: { code: 'internal', message: 'Something went wrong.' } }
  },
})
```

`onError` runs inside the middleware chain, so response headers set by middleware survive.
