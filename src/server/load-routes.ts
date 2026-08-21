import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compareCodePoints, isMethod, METHODS } from '../openapi/main.ts'
import { RouteError } from './errors.ts'
import { createRouter } from './router.ts'
import type { AnyHandler, Middleware, Router } from './types.ts'

export interface LoadRoutesOptions {
  /**
   * Prefix for every route.
   */
  basePath?: string
  /**
   * Skip these. A leading double-star segment matches zero or more directories.
   */
  ignore?: string[]
  /**
   * Import every module up front, so a broken one fails at startup rather than on a request.
   */
  eager?: boolean
}

const DEFAULT_IGNORE = ['**/*.test.ts', '**/_*.ts']

/**
 * Turns one glob into a matcher. Only the subset the documented defaults need: a leading
 * double-star segment for zero or more directories, and `*` for anything but a slash.
 */
function toMatcher(pattern: string): (relative: string) => boolean {
  const source = pattern
    .split('**/')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    // `**/` must also match zero directories, so `**/_*.ts` catches a root-level `_x.ts`.
    .join('(?:.*/)?')
  const re = new RegExp(`^${source}$`)
  return (relative) => re.test(relative)
}

/**
 * Directory names that shape the URL rather than appearing in it.
 */
function segmentFor(name: string): string | undefined {
  if (name.startsWith('(') && name.endsWith(')')) return undefined
  if (name.startsWith('[...') && name.endsWith(']')) return `{...${name.slice(4, -1)}}`
  if (name.startsWith('[') && name.endsWith(']')) return `{${name.slice(1, -1)}}`
  return name
}

export interface DiscoveredRoute {
  method: string
  /**
   * Matcher pattern, so a catch-all survives.
   */
  pattern: string
  file: string
  middleware: string[]
}

/**
 * Walks an `api/` folder and reports what it finds, without importing anything.
 */
export async function discoverRoutes(dir: string, options: LoadRoutesOptions = {}): Promise<DiscoveredRoute[]> {
  const root = resolve(dir)
  const ignore = (options.ignore ?? DEFAULT_IGNORE).map(toMatcher)
  const base = options.basePath && options.basePath !== '/' ? options.basePath.replace(/\/$/, '') : ''
  const found: DiscoveredRoute[] = []

  async function walk(absolute: string, segments: string[], middleware: string[]): Promise<void> {
    const entries = await readdir(absolute, { withFileTypes: true })
    // Sorted so a route set never depends on readdir order.
    const sortedEntries = [...entries].sort((a, b) => compareCodePoints(a.name, b.name))
    const names = sortedEntries.map((e) => e.name)

    const chain = names.includes('middleware.ts') ? [...middleware, join(absolute, 'middleware.ts')] : middleware

    for (const entry of sortedEntries) {
      const { name } = entry
      const child = join(absolute, name)
      const relative = child.slice(root.length + 1).replaceAll('\\', '/')

      if (entry.isDirectory()) {
        const segment = segmentFor(name)
        await walk(child, segment === undefined ? segments : [...segments, segment], chain)
        continue
      }

      if (!name.endsWith('.ts')) continue
      if (ignore.some((m) => m(relative))) continue
      if (name === 'middleware.ts' || name === 'schemas.ts') continue

      const method = name.slice(0, -3)
      if (!isMethod(method)) {
        // A stray file is a mistake worth naming: silently ignoring it hides a route that the
        // author believes exists.
        throw new RouteError(`${JSON.stringify(name)} is not a route file. Expected one of ${METHODS.join(', ')}, or a reserved name`, child)
      }

      found.push({ method, pattern: `${base}/${segments.join('/')}`.replace(/\/+$/, '') || '/', file: child, middleware: chain })
    }
  }

  await walk(root, [], [])
  // Sort so nothing inherits readdir order. Code points, not `localeCompare`, which would make
  // the result depend on the machine's locale.
  found.sort((a, b) => (a.pattern === b.pattern ? compareCodePoints(a.method, b.method) : compareCodePoints(a.pattern, b.pattern)))
  return found
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * A dynamically imported module is `unknown`, so both exports are checked before use. Only arity is
 * observable at runtime, which is why the checks are shape rather than signature.
 */
function isMiddleware(value: unknown): value is Middleware {
  return typeof value === 'function'
}

function isHandler(value: unknown): value is AnyHandler {
  return typeof value === 'function'
}

async function importMiddleware(files: string[]): Promise<Middleware[]> {
  const layers: Middleware[] = []
  for (const file of files) {
    const module: unknown = await import(pathToFileURL(file).href)
    const value = isRecord(module) ? module.default : undefined
    const chain = Array.isArray(value) ? value : [value]
    if (!chain.every(isMiddleware)) throw new RouteError('A middleware.ts file must default-export a Middleware or an array of them', file)
    layers.push(...chain)
  }
  return layers
}

async function importHandler(file: string): Promise<AnyHandler> {
  const module: unknown = await import(pathToFileURL(file).href)
  const handler = isRecord(module) ? module.handler : undefined
  if (!isHandler(handler)) throw new RouteError('A route module must export a `handler` function', file)
  return handler
}

/**
 * Scans an `api/` folder and returns a router for it.
 */
export async function loadRoutes(dir: string, options: LoadRoutesOptions = {}): Promise<Router> {
  const router = createRouter()
  const eager = options.eager ?? true
  const discovered = await discoverRoutes(dir, options)

  for (const route of discovered) {
    const middleware = await importMiddleware(route.middleware)
    if (eager) {
      const handler = await importHandler(route.file)
      router.add(route.method, route.pattern, { handler, middleware, file: route.file })
    } else {
      router.add(route.method, route.pattern, { load: () => importHandler(route.file), middleware, file: route.file })
    }
  }

  return router
}
