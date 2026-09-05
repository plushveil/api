import type { Context, IndexedOperation, Runtime } from './types.ts'

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
 * Reads and parses the request body, honouring `limit`. Returns `undefined` for a method that
 * cannot carry one.
 *
 * `operation`, when given, is the matched route's spec-derived entry (see `findOperation` in
 * `validate.ts`): its `content` map is what tells a declared binary media type apart from JSON,
 * and its `x-stream` flag from a buffered one. Without an `operation` -- no `spec` configured, or
 * no route matched -- the content type alone decides: `json`/empty stays JSON, form-urlencoded
 * stays form-urlencoded, `text/*` becomes a string, and everything else becomes a buffered
 * `Uint8Array` instead of the UTF-8-decoded (and therefore corrupted) string earlier versions
 * produced.
 */
export async function readBody(request: Request, operation: IndexedOperation | undefined, limit: number): Promise<unknown> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined

  const type = (request.headers.get('content-type') ?? '').split(';')[0].trim()

  const declared = operation?.requestBody?.content.get(type)
  if (declared?.stream) return request.body ?? undefined

  if (type === '' || type.includes('json')) {
    const text = await readLimitedText(request, limit)
    if (text === '') return undefined
    try {
      return JSON.parse(text)
    } catch {
      // Leave it as text; validation reports the mismatch with a location.
      return text
    }
  }

  if (type === 'application/x-www-form-urlencoded') {
    const text = await readLimitedText(request, limit)
    if (text === '') return undefined
    const params = new URLSearchParams(text)
    const body: Record<string, unknown> = {}
    for (const key of new Set(params.keys())) {
      const values = params.getAll(key)
      body[key] = values.length > 1 ? values : values[0]
    }
    return body
  }

  if (type.startsWith('text/')) {
    const text = await readLimitedText(request, limit)
    return text === '' ? undefined : text
  }

  const bytes = await readLimitedBytes(request, limit)
  return bytes.byteLength === 0 ? undefined : bytes
}

async function readLimitedText(request: Request, limit: number): Promise<string> {
  return new TextDecoder().decode(await readLimitedBytes(request, limit))
}

/**
 * Reads the body into one `Uint8Array`, rejecting it as early as possible when it exceeds `limit`:
 * immediately from `content-length` when the client sent one, otherwise incrementally as chunks
 * arrive, so an unbounded body is rejected mid-stream rather than buffered in full first.
 */
async function readLimitedBytes(request: Request, limit: number): Promise<Uint8Array> {
  const declaredLength = request.headers.get('content-length')
  if (declaredLength && Number(declaredLength) > limit) throw new PayloadTooLargeError(limit)

  const { body } = request
  if (!body) return new Uint8Array(0)

  const chunks: Uint8Array[] = []
  let total = 0
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) throw new PayloadTooLargeError(limit)
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
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
