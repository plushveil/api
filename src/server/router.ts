import { run } from './compose.ts'
import { compareRoutes, matchSegments, parsePattern, patternToPath, splitPath } from './route-path.ts'
import type { AddOptions, AnyHandler, Context, Middleware, Route, Router } from './types.ts'

function isAddOptions(value: AnyHandler | AddOptions): value is AddOptions {
  return typeof value === 'object' && value !== null
}

/**
 * `/` contributes no prefix; anything else is normalised to start with a slash.
 */
function normalisePrefix(prefix: string): string {
  if (prefix === '/') return ''
  return prefix.startsWith('/') ? prefix : `/${prefix}`
}

/**
 * Creates a router. Usable on its own, or handed to `createServer` via the `routes` option.
 *
 * Routes are held in a flat array kept sorted by specificity and matched by linear scan. A trie
 * would win on very large route tables; at the sizes an `api/` folder produces, the array is
 * faster to build and far easier to reason about.
 */
export function createRouter(): Router {
  const routes: Route[] = []
  const middleware: Middleware[] = []

  const router: Router = {
    use(layer) {
      middleware.push(layer)
      return router
    },

    /**
     * `add(method, path, handler)` is the documented form. The object form is the seam
     * `loadRoutes` uses for lazily imported modules — a `Handler` and a `() => Promise<Handler>`
     * are indistinguishable at runtime, so they cannot share one positional argument.
     */
    add(method, path, handler, options) {
      const resolved: AddOptions = isAddOptions(handler) ? handler : { handler, ...options }
      const pattern = path.startsWith('/') ? path : `/${path}`
      routes.push({
        method: method.toUpperCase(),
        pattern,
        path: patternToPath(pattern),
        segments: parsePattern(pattern),
        middleware: resolved.middleware ?? [],
        file: resolved.file,
        handler: resolved.handler,
        load: resolved.load,
      })
      routes.sort(compareRoutes)
      return router
    },

    /**
     * Nests a router under a prefix. Flattened eagerly: the child's own middleware is prepended to
     * each copied route, so a mounted route carries its chain with it.
     */
    mount(prefix, child) {
      const base = normalisePrefix(prefix)
      for (const route of child.routes) {
        const pattern = `${base}${route.pattern}` || '/'
        routes.push({
          ...route,
          pattern,
          path: patternToPath(pattern),
          segments: parsePattern(pattern),
          middleware: [...child.middleware, ...route.middleware],
        })
      }
      routes.sort(compareRoutes)
      return router
    },

    match(method, pathname) {
      const parts = splitPath(pathname)
      const wanted = method.toUpperCase()
      for (const route of routes) {
        if (route.method !== wanted) continue
        const path = matchSegments(route.segments, parts)
        if (path) return { route, path }
      }
      return undefined
    },

    async handle(context, hooks) {
      const found = router.match(context.request.method, context.request.url.pathname)
      if (!found) {
        context.response.status = 404
        context.response.body = { error: 'not_found', message: 'No route matches this request.' }
        return
      }

      const { route } = found
      context.request.path = found.path
      context.operation = { method: route.method, path: route.path, file: route.file }

      const handler = route.handler ?? (route.load ? await route.load() : undefined)
      if (!handler) {
        context.response.status = 500
        context.response.body = { error: 'internal', message: 'The route has no handler.' }
        return
      }

      await run([...middleware, ...route.middleware], context, async () => {
        // Validation happens here, after the match and before the handler.
        await hooks?.beforeHandler?.(context)
        const result = await handler(context.request, context)
        applyResult(context, result)
        await hooks?.afterHandler?.(context)
      })
    },

    get routes() {
      return routes
    },

    get middleware() {
      return middleware
    },
  }

  return router
}

/**
 * Copies a handler's return value onto the response context.
 */
export function applyResult(context: Context, result: unknown): void {
  if (result === undefined || result === null) return
  if (result instanceof Response) {
    context.response.status = result.status
    context.response.body = result
    return
  }
  const shaped = result as { status?: number; body?: unknown; headers?: Record<string, string> }
  if (typeof shaped.status === 'number') context.response.status = shaped.status
  if ('body' in shaped) context.response.body = shaped.body
  if (shaped.headers) {
    for (const [key, value] of Object.entries(shaped.headers)) context.response.headers.set(key, value)
  }
}
