import type { Context, Runtime } from './types.ts'

/**
 * Parses a `cookie` header. Names are case-sensitive; only headers are not.
 */
export function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>()
  if (!header) return cookies
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=')
    if (index === -1) continue
    const name = pair.slice(0, index).trim()
    if (!name) continue
    const value = pair.slice(index + 1).trim()
    try {
      cookies.set(name, decodeURIComponent(value))
    } catch {
      cookies.set(name, value)
    }
  }
  return cookies
}

/**
 * Collapses a query string into a plain object. A repeated key becomes an array, so an operation
 * declaring `string[]` sees one.
 */
export function parseQuery(url: URL): Record<string, unknown> {
  const query: Record<string, unknown> = {}
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key)
    query[key] = values.length > 1 ? values : values[0]
  }
  return query
}

export interface CreateContextOptions {
  request: Request
  runtime?: Runtime
  raw?: unknown
  signal?: AbortSignal
}

/**
 * Builds the context for one request. The body is not read until something asks for it.
 */
export function createContext(options: CreateContextOptions): Context {
  const { request } = options
  const url = new URL(request.url)

  return {
    request: {
      method: request.method.toUpperCase(),
      url,
      headers: request.headers,
      cookies: parseCookies(request.headers.get('cookie')),
      path: {},
      query: parseQuery(url),
      body: undefined,
      raw: options.raw,
    },
    response: {
      status: 200,
      headers: new Headers(),
      body: undefined,
    },
    state: {},
    signal: options.signal ?? request.signal,
    runtime: options.runtime,
  }
}

/**
 * Reads and parses the request body, honouring `bodyLimit`. Returns `undefined` for a method that
 * cannot carry one.
 */
export async function readBody(request: Request, limit: number): Promise<unknown> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined

  const text = await readLimited(request, limit)
  if (text === '') return undefined

  const type = request.headers.get('content-type') ?? ''
  if (type.includes('json') || type === '') {
    try {
      return JSON.parse(text)
    } catch {
      // Leave it as text; validation reports the mismatch with a location.
      return text
    }
  }
  if (type.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(text)
    const body: Record<string, unknown> = {}
    for (const key of new Set(params.keys())) {
      const values = params.getAll(key)
      body[key] = values.length > 1 ? values : values[0]
    }
    return body
  }
  return text
}

async function readLimited(request: Request, limit: number): Promise<string> {
  const buffer = await request.arrayBuffer()
  if (buffer.byteLength > limit) throw new PayloadTooLargeError(limit)
  return new TextDecoder().decode(buffer)
}

/**
 * Raised when a request body exceeds `bodyLimit`.
 */
export class PayloadTooLargeError extends Error {
  readonly limit: number

  constructor(limit: number) {
    super(`The request body exceeds the ${limit} byte limit`)
    this.name = 'PayloadTooLargeError'
    this.limit = limit
  }
}
