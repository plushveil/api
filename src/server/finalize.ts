import type { Context } from './types.ts'

/**
 * Statuses for which the Response constructor refuses a body. Not just 204 and 304: constructing
 * `new Response('x', { status: 205 })` throws, so a legal handler result would otherwise make
 * `server.fetch()` reject instead of resolving.
 */
const NULL_BODY = new Set([101, 103, 204, 205, 304])

/**
 * Turns the response context into a web `Response`.
 */
export function finalize(context: Context): Response {
  const { status, headers, body } = context.response

  // Outside this range the constructor throws, so clamp to a 500 rather than crashing the request.
  const code = Number.isInteger(status) && status >= 200 && status <= 599 ? status : 500

  if (body instanceof Response) return body

  if (NULL_BODY.has(code) || body === undefined || body === null) {
    return new Response(null, { status: code, headers })
  }

  if (typeof body === 'string') {
    if (!headers.has('content-type')) headers.set('content-type', 'text/plain; charset=utf-8')
    return new Response(body, { status: code, headers })
  }

  if (body instanceof Uint8Array || body instanceof ArrayBuffer || body instanceof ReadableStream) {
    if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream')
    return new Response(body, { status: code, headers })
  }

  if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify(body), { status: code, headers })
}
