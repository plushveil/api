/**
 * The client runtime. Built on the global `fetch`, with no dependencies.
 *
 * Every verb funnels through one `call`; the per-verb methods exist so the types can narrow the
 * path to those that declare that verb.
 */

import { ApiRequestError, ApiResponseError } from './errors.ts'
import type { ApiShape, Client, ClientMiddleware, ClientOptions, Verb } from './types.ts'

const VERBS: Verb[] = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']

interface CallInput {
  path?: Record<string, unknown>
  query?: Record<string, unknown>
  headers?: Record<string, unknown>
  cookies?: Record<string, unknown>
  body?: unknown
  signal?: AbortSignal
  timeout?: number
  fetch?: typeof fetch
}

/**
 * Renders a parameter value as a string.
 *
 * `String(value)` is not enough: an object would silently become `[object Object]`, which is a
 * plausible-looking request that means nothing. Only primitives have an unambiguous textual form,
 * so anything else is JSON-encoded until `style: deepObject` is supported.
 */
export function toParamValue(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value)
    default:
      return JSON.stringify(value) ?? ''
  }
}

/**
 * Interpolates `{name}` and percent-encodes each value.
 */
export function interpolate(template: string, params: Record<string, unknown> | undefined): string {
  return template.replace(/\{(?<spread>\.\.\.)?(?<name>[^}]+)\}/g, (match: string, spread: string | undefined, name: string) => {
    const value = params?.[name]
    if (value === undefined || value === null) throw new ApiRequestError(`The path parameter ${JSON.stringify(name)} is required`)
    // A catch-all already contains separators, so its segments are encoded individually.
    if (spread) return toParamValue(value).split('/').map(encodeURIComponent).join('/')
    return encodeURIComponent(toParamValue(value))
  })
}

/**
 * Serialises a query, defaulting to `form` style with `explode: true`.
 */
export function serializeQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const item of value) if (item !== undefined && item !== null) params.append(key, toParamValue(item))
      continue
    }
    params.append(key, toParamValue(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

function serializeCookies(cookies: Record<string, unknown> | undefined): string | undefined {
  if (!cookies) return undefined
  const parts = Object.entries(cookies)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => `${name}=${encodeURIComponent(toParamValue(value))}`)
  return parts.length > 0 ? parts.join('; ') : undefined
}

function defaultBodySerializer(body: unknown): { body: BodyInit; contentType?: string } {
  if (typeof body === 'string') return { body, contentType: 'text/plain; charset=utf-8' }
  if (body instanceof Uint8Array || body instanceof ArrayBuffer || body instanceof ReadableStream) {
    // Raw bytes carry no type of their own, unlike the three below -- `Request` would send them
    // with no `content-type` at all otherwise.
    return { body: body as BodyInit, contentType: 'application/octet-stream' }
  }
  if (body instanceof Blob || body instanceof FormData || body instanceof URLSearchParams) {
    // Each already carries its own content type -- a `Blob`'s `type` (so a `File` keeps the type
    // the browser gave it), `FormData`'s multipart boundary, `URLSearchParams`'s form encoding --
    // which `Request` derives when no header is set already. Setting one here would only risk
    // overriding it with something less accurate.
    return { body: body as BodyInit }
  }
  return { body: JSON.stringify(body), contentType: 'application/json' }
}

/**
 * Parses a response by content type. Reads a clone, so `result.response` is still unread.
 */
async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205 || response.status === 304) return undefined
  const type = response.headers.get('content-type') ?? ''
  const clone = response.clone()
  if (type.includes('json')) {
    const text = await clone.text()
    if (text === '') return undefined
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  if (type.startsWith('text/') || type === '') return clone.text()
  return new Uint8Array(await clone.arrayBuffer())
}

type BodyInit = NonNullable<ConstructorParameters<typeof Response>[0]>

/**
 * Builds the request URL, reporting a failure as a request that never happened.
 */
function buildUrl(baseUrl: string, template: string, input: CallInput, serializeQueryString: (query: Record<string, unknown>) => string): string {
  try {
    return `${baseUrl}${interpolate(template, input.path)}${serializeQueryString(input.query ?? {})}`
  } catch (cause) {
    if (cause instanceof ApiRequestError) throw cause
    throw new ApiRequestError('The request URL could not be built', { cause })
  }
}

/**
 * Serialises the body, if there is one, and sets the content type it implies.
 */
function buildBody(input: CallInput, headers: Headers, serializeBody: (body: unknown) => { body: BodyInit; contentType?: string }): BodyInit | undefined {
  if (input.body === undefined) return undefined
  try {
    const { body, contentType } = serializeBody(input.body)
    if (contentType && !headers.has('content-type')) headers.set('content-type', contentType)
    return body
  } catch (cause) {
    throw new ApiRequestError('The request body could not be serialised', { cause })
  }
}

/**
 * One signal, none, or the union of several.
 */
function combineSignals(signals: AbortSignal[]): AbortSignal | undefined {
  if (signals.length === 0) return undefined
  if (signals.length === 1) return signals[0]
  return AbortSignal.any(signals)
}

/**
 * Creates a typed client for a generated `Api` interface.
 */
export function createClient<Api extends ApiShape>(options: ClientOptions & { throwOnError: true }): Client<Api, true>
export function createClient<Api extends ApiShape>(options: ClientOptions & { throwOnError?: false | undefined }): Client<Api>
export function createClient<Api extends ApiShape>(options: ClientOptions): Client<Api, boolean>
export function createClient<Api extends ApiShape>(options: ClientOptions): Client<Api, boolean> {
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const middleware: ClientMiddleware[] = [...(options.middleware ?? [])]
  const serializeBody = options.bodySerializer ?? defaultBodySerializer
  const serializeQueryString = options.querySerializer ?? serializeQuery
  const throwOnError = options.throwOnError === true

  async function defaultHeaders(): Promise<Headers> {
    const source = typeof options.headers === 'function' ? await options.headers() : options.headers
    return new Headers(source ?? {})
  }

  async function call(verb: Verb, template: string, input: CallInput = {}): Promise<unknown> {
    const headers = await defaultHeaders()

    for (const [name, value] of Object.entries(input.headers ?? {})) {
      if (value === undefined || value === null) continue
      headers.set(name, toParamValue(value))
    }

    const cookie = serializeCookies(input.cookies)
    if (cookie) headers.set('cookie', cookie)

    const url = buildUrl(baseUrl, template, input, serializeQueryString)
    const body = buildBody(input, headers, serializeBody)

    const timeout = input.timeout ?? options.timeout
    const signals = [input.signal, timeout === undefined ? undefined : AbortSignal.timeout(timeout)].filter((s): s is AbortSignal => s !== undefined)
    const signal = combineSignals(signals)

    // A ReadableStream body requires `duplex: 'half'`, or the Request constructor throws --
    // undici's requirement for any request that streams a body rather than buffering one.
    const duplex = body instanceof ReadableStream ? 'half' : undefined
    const request = new Request(url, { method: verb.toUpperCase(), headers, body, signal, duplex })
    const implementation = input.fetch ?? options.fetch ?? fetch

    // Middleware may retry, so the terminal clones rather than consuming the request it was given.
    const terminal = async (final: Request): Promise<Response> => {
      try {
        return await implementation(final.body ? final.clone() : final)
      } catch (cause) {
        throw new ApiRequestError(`The request to ${url} failed`, { cause })
      }
    }

    const chain = middleware.reduceRight<(request: Request) => Promise<Response>>((next, layer) => (current) => layer(current, next), terminal)

    const response = await chain(request)
    const parsed = await parseBody(response)

    if (throwOnError && !response.ok) throw new ApiResponseError(response.status, parsed, response)

    if (throwOnError) return parsed

    return {
      status: response.status,
      body: parsed,
      headers: response.headers,
      response,
      ok: response.ok,
    }
  }

  const verbs: Record<string, (path: string, input?: CallInput) => Promise<unknown>> = {}
  for (const verb of VERBS) verbs[verb] = (path, input) => call(verb, path, input)

  const table = {
    ...verbs,
    use(layer: ClientMiddleware) {
      middleware.push(layer)
      return client
    },
  }

  /**
   * The one irreducible conversion in this package.
   *
   * `Client<Api>` is a mapped type whose every method is generic in the path, and its return type
   * depends on that path. No single runtime function can satisfy that signature, and the seven
   * verbs are built from a loop, so the table has to be adopted as the mapped type here. Everything
   * on the other side of this line is fully typed — `call` is the only untyped seam, and the
   * compile-time suite in test/types pins the behaviour this claims.
   */
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const client = table as unknown as Client<Api, boolean>

  return client
}
