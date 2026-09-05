import { readFile } from 'node:fs/promises'
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { parseDocument, type Document } from '../openapi/main.ts'
import { createListener, sendResponse } from './adapters/node.ts'
import { createContext } from './context.ts'
import { defaultOnError, dispatch } from './dispatch.ts'
import { loadRoutes } from './load-routes.ts'
import { createRouter } from './router.ts'
import type { Router, Runtime, ServerOptions } from './types.ts'
import { checkCoverage, indexSpec, resolveValidateOptions } from './validate.ts'

export interface Server {
  listen: (port?: number, hostname?: string) => Promise<AddressInfo>
  close: () => Promise<void>
  use: (middleware: NonNullable<ServerOptions['middleware']>[number]) => Server
  readonly router: Router
  fetch: (request: Request) => Promise<Response>
  readonly http: HttpServer
}

/**
 * `address()` is a union because a server may be bound to a pipe; listening on TCP narrows it.
 */
function addressOf(server: HttpServer): AddressInfo {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The server is not listening on a TCP port')
  return address
}

const NOT_FOUND = () => ({ status: 404, body: { error: 'not_found', message: 'No route matches this request.' } })

/**
 * Creates a server. Synchronous, so `server.router` is available immediately; route and spec
 * loading happen in a `ready` promise that `listen`, `close`, and `fetch` all await.
 */
export function createServer(options: ServerOptions = {}): Server {
  const basePath = options.basePath && options.basePath !== '/' ? `/${options.basePath.replace(/^\/|\/$/g, '')}` : '/'

  const runtime: Runtime = {
    options,
    basePath,
    validate: resolveValidateOptions(options.validate),
    spec: undefined,
    middleware: [...(options.middleware ?? [])],
    onError: options.onError ?? defaultOnError,
    notFound: options.notFound ?? NOT_FOUND,
    body: { limit: options.bodyLimit ?? 1_048_576 },
  }

  let router: Router = typeof options.routes === 'string' || options.routes === undefined ? createRouter() : options.routes
  let document: Document | undefined = undefined
  let inFlight = 0
  let idle: (() => void) | undefined = undefined

  const ready = (async () => {
    if (typeof options.routes === 'string') {
      // Routes are stored without basePath; the spec lookup key adds it. Applying it in both
      // places would make every lookup miss and silently disable validation.
      router = await loadRoutes(options.routes)
    }

    if (options.spec !== undefined) {
      document = typeof options.spec === 'string' ? parseDocument(await readFile(options.spec, 'utf8')) : options.spec
      runtime.spec = indexSpec(document, basePath)
      const strict = runtime.validate?.request === 'strict'
      const missing = checkCoverage(
        runtime.spec,
        router.routes.map((r) => ({ method: r.method, path: `${basePath === '/' ? '' : basePath}${r.path}` })),
        strict,
      )
      for (const route of missing) console.warn(`No operation in the specification for ${route}; it will be served without validation`)
    }
  })()

  function stripBasePath(pathname: string): string {
    if (basePath === '/') return pathname
    if (pathname === basePath) return '/'
    return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname
  }

  async function handle(request: Request, raw?: IncomingMessage, signal?: AbortSignal): Promise<Response> {
    await ready
    const context = createContext({ request, runtime, raw, signal })

    if (basePath !== '/') {
      const stripped = stripBasePath(context.request.url.pathname)
      if (stripped !== context.request.url.pathname) context.request.url = new URL(stripped + context.request.url.search, context.request.url.origin)
    }

    return dispatch(runtime, router, context, document, request)
  }

  const server: Server = {
    async listen(port = 0, hostname = '0.0.0.0') {
      await ready
      await new Promise<void>((resolve, reject) => {
        http.once('error', reject)
        http.listen(port, hostname, () => {
          http.removeListener('error', reject)
          resolve()
        })
      })
      return addressOf(http)
    },

    async close() {
      await new Promise<void>((resolve) => {
        http.close(() => resolve())
      })
      // Wait for anything still writing. `inFlight` is tracked around the whole listener, not just
      // dispatch, so a streaming body still counts.
      if (inFlight > 0) {
        await new Promise<void>((resolve) => {
          idle = resolve
        })
      }
    },

    use(middleware) {
      runtime.middleware.push(middleware)
      return server
    },

    get router() {
      return router
    },

    async fetch(request) {
      inFlight++
      try {
        return await handle(request)
      } finally {
        settle()
      }
    },

    get http() {
      return http
    },
  }

  const http = createHttpServer(
    createListener({
      trustProxy: options.trustProxy,
      handle: (request, raw, signal) => handle(request, raw, signal),
      onStarted: () => {
        inFlight++
      },
      onSettled: settle,
    }),
  )

  function settle(): void {
    inFlight--
    if (inFlight === 0 && idle) {
      idle()
      idle = undefined
    }
  }

  return server
}

export { sendResponse }
