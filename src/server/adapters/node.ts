/**
 * The only place `node:http` appears. Everything inward of here speaks web `Request` and
 * `Response`, so the socket path and `server.fetch` share one code path.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface ToRequestOptions {
  trustProxy?: boolean
  signal?: AbortSignal
}

/**
 * Builds a web `Request` from a Node message.
 */
export function toRequest(message: IncomingMessage, options: ToRequestOptions = {}): Request {
  const headers = new Headers()
  for (const [key, value] of Object.entries(message.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const v of value) headers.append(key, v)
    else headers.set(key, value)
  }

  // A TLS socket carries `encrypted`; a plain one does not.
  const socketEncrypted = 'encrypted' in message.socket
  const forwardedProto = options.trustProxy ? headers.get('x-forwarded-proto') : null
  const forwardedHost = options.trustProxy ? headers.get('x-forwarded-host') : null

  const protocol = forwardedProto?.split(',')[0]?.trim() ?? (socketEncrypted ? 'https' : 'http')
  const host = forwardedHost?.split(',')[0]?.trim() ?? headers.get('host') ?? 'localhost'
  const url = new URL(message.url ?? '/', `${protocol}://${host}`)

  const method = (message.method ?? 'GET').toUpperCase()
  const hasBody = method !== 'GET' && method !== 'HEAD'

  return new Request(url, {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(message) as ReadableStream<Uint8Array>) : undefined,
    // Required by undici whenever a body is present.
    duplex: hasBody ? 'half' : undefined,
    signal: options.signal,
  })
}

/**
 * Writes a web `Response` to a Node response.
 */
export async function sendResponse(response: Response, target: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {}
  for (const [key, value] of response.headers) {
    if (key === 'set-cookie') {
      // Several Set-Cookie headers are legal and must stay separate, so they accumulate.
      const existing = headers[key]
      if (Array.isArray(existing)) headers[key] = [...existing, value]
      else if (existing === undefined) headers[key] = [value]
      else headers[key] = [existing, value]
      continue
    }
    headers[key] = value
  }

  target.writeHead(response.status, headers)

  if (!response.body) {
    target.end()
    return
  }

  await pipeline(Readable.fromWeb(response.body), target)
}

export interface ListenerOptions {
  trustProxy?: boolean
  handle: (request: Request, raw: IncomingMessage, signal: AbortSignal) => Promise<Response>
  onSettled?: () => void
  onStarted?: () => void
}

/**
 * Builds the `request` listener.
 */
export function createListener(options: ListenerOptions) {
  return (message: IncomingMessage, target: ServerResponse): void => {
    const controller = new AbortController()

    /**
     * Abort from the *response* side. `message.on('close')` fires when the request message
     * completes, which for any request with a body happens long before the handler finishes — using
     * it would abort almost every POST. `response.on('close')` with `writableFinished` false is the
     * actual "client went away" signal.
     */
    target.on('close', () => {
      if (!target.writableFinished) controller.abort()
    })

    options.onStarted?.()

    const request = toRequest(message, { trustProxy: options.trustProxy, signal: controller.signal })

    options
      .handle(request, message, controller.signal)
      .then((response) => sendResponse(response, target))
      .catch((error: unknown) => {
        console.error('Failed to serve a request', error)
        if (!target.headersSent) target.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        if (!target.writableEnded) target.end(JSON.stringify({ error: 'internal', message: 'Something went wrong.' }))
      })
      .finally(() => options.onSettled?.())
  }
}
