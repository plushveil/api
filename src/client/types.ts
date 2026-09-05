/**
 * The type machinery behind `createClient`. This is the risky half of the client and it is
 * type-only, so it costs nothing at runtime.
 *
 * Reference: docs/CONTRIBUTING/CLIENT.md.
 */

/**
 * The seven verbs. There is deliberately no `trace`: it is a forbidden method for `fetch`.
 */
export type Verb = 'delete' | 'get' | 'head' | 'options' | 'patch' | 'post' | 'put'

/**
 * The shape of one operation in a generated `Api` interface.
 */
export interface OperationShape {
  path?: Record<string, unknown>
  query?: Record<string, unknown>
  headers?: Record<string, unknown>
  cookies?: Record<string, unknown>
  body?: unknown
  responses: Record<number, unknown>
}

/**
 * The constraint on a generated `Api`.
 *
 * Deliberately just `object` rather than `Record<string, …>`: `api.types.ts` declares `Api` as an
 * `interface`, and TypeScript grants an implicit index signature only to type aliases, so a
 * structural constraint would reject the very type this client exists to consume. The shape is
 * enforced where it is used instead, by `OperationAt`.
 */
export type ApiShape = object

/**
 * Keys that must be supplied. An object with none of them can be omitted entirely.
 */
export type RequiredKeysOf<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T]

type HeaderValues = Record<string, boolean | number | string | undefined>

/**
 * Every part below tests presence with `'k' extends keyof Op`, never by inspecting `Op['k']`.
 * An absent key resolves to `unknown`, not `never`, so `[Op['body']] extends [never]` is false and
 * a body-less operation would otherwise be handed a required `body: unknown`.
 */
type PathPart<Op> = 'path' extends keyof Op ? { path: Op['path'] } : { path?: undefined }

type QueryPart<Op> = 'query' extends keyof Op ? ([RequiredKeysOf<Op['query']>] extends [never] ? { query?: Op['query'] } : { query: Op['query'] }) : { query?: undefined }

type CookiePart<Op> = 'cookies' extends keyof Op ? ([RequiredKeysOf<Op['cookies']>] extends [never] ? { cookies?: Op['cookies'] } : { cookies: Op['cookies'] }) : { cookies?: undefined }

type HeaderPart<Op> = 'headers' extends keyof Op ? ([RequiredKeysOf<Op['headers']>] extends [never] ? { headers?: HeaderValues & Op['headers'] } : { headers: HeaderValues & Op['headers'] }) : { headers?: HeaderValues }

/**
 * Unwraps `@plushveil/api/server`'s `Content<M, T>` to the payload a caller actually supplies or
 * reads. Matched structurally, rather than importing `Content` itself, so this package stays
 * independent of the server package the way `OperationShape` above already is.
 */
type ClientPayload<T> = T extends { readonly mediaType: string; readonly body: infer B } ? B : T

/**
 * A declared buffered-or-streamed byte body also accepts a `Blob`/`File`: the browser value a
 * `<input type="file">` or a drag-and-drop hands you, without reading it into memory first to
 * produce the exact type the operation declares.
 */
type WidenBody<T> = T extends Uint8Array | ArrayBuffer | ReadableStream<Uint8Array> ? T | Blob | File : T

type BodyPart<Op> = 'body' extends keyof Op ? ([Op['body']] extends [never] ? { body?: undefined } : { body: WidenBody<ClientPayload<Op['body']>> }) : { body?: undefined }

/**
 * Options that never come from the operation.
 */
export interface CallOptions {
  signal?: AbortSignal
  timeout?: number
  fetch?: typeof fetch
}

export type RequestOptions<Op> = PathPart<Op> & QueryPart<Op> & HeaderPart<Op> & CookiePart<Op> & BodyPart<Op> & CallOptions

/**
 * The second argument becomes optional when nothing in it is required, which is what lets
 * `client.get('/health')` be called with no options at all.
 */
export type RequestArgs<Op> = [RequiredKeysOf<RequestOptions<Op>>] extends [never] ? [options?: RequestOptions<Op>] : [options: RequestOptions<Op>]

/**
 * A response body typed `ReadableStream<Uint8Array>` (a streamed `Content<M, T>`, declared so the
 * *server* hands a handler the unbuffered request the same way) is never actually a stream on the
 * client: `parseBody` in `client.ts` always resolves a non-JSON, non-text response to a buffered
 * `Uint8Array` -- there is no per-call option to ask for a live stream instead. Collapsing the type
 * to match keeps a caller from calling `.getReader()` on a value that was never one.
 */
type ResponsePayload<T> = ClientPayload<T> extends ReadableStream<Uint8Array> ? Uint8Array : ClientPayload<T>

/**
 * A response body typed `never` in the spec means there is no body. Unwrapped through
 * `ClientPayload` for the same reason `BodyPart` is: `parseBody` in `client.ts` resolves to the
 * payload a `Content<M, T>` response declares, not the wrapper.
 */
export type BodyAt<R, S extends keyof R> = [R[S]] extends [never] ? undefined : ResponsePayload<R[S]>

export interface ApiResponse<S, B> {
  status: S
  body: B
  headers: Headers
  response: Response
  ok: boolean
}

/**
 * The result union, discriminated on the literal status.
 */
export type ApiResult<Op extends OperationShape> = {
  [S in keyof Op['responses']]: ApiResponse<S, BodyAt<Op['responses'], S>>
}[keyof Op['responses']]

type Is2xx<S> = `${S & number}` extends `2${string}` ? true : false

/**
 * With `throwOnError`, the call resolves to the success bodies alone.
 */
export type SuccessBody<Op extends OperationShape> = {
  [S in keyof Op['responses']]: Is2xx<S> extends true ? BodyAt<Op['responses'], S> : never
}[keyof Op['responses']]

/**
 * Paths in `Api` that declare `V`.
 */
export type PathsWith<Api extends ApiShape, V extends Verb> = {
  [P in keyof Api]: V extends keyof Api[P] ? P : never
}[keyof Api]

type OperationAt<Api extends ApiShape, P extends keyof Api, V extends Verb> = V extends keyof Api[P] ? (Api[P][V] extends OperationShape ? Api[P][V] : never) : never

/**
 * What one call resolves to, given the client's `throwOnError` setting.
 */
export type CallResult<Op extends OperationShape, Throw extends boolean> = Throw extends true ? SuccessBody<Op> : ApiResult<Op>

/**
 * Client middleware. May call `next` more than once, which is how a retry works.
 */
export type ClientMiddleware = (request: Request, next: (request: Request) => Promise<Response>) => Promise<Response>

type Method<Api extends ApiShape, V extends Verb, Throw extends boolean> = <P extends PathsWith<Api, V>>(path: P, ...args: RequestArgs<OperationAt<Api, P, V>>) => Promise<CallResult<OperationAt<Api, P, V>, Throw>>

export type Client<Api extends ApiShape, Throw extends boolean = false> = {
  [V in Verb]: Method<Api, V, Throw>
} & {
  use: (middleware: ClientMiddleware) => Client<Api, Throw>
}

export interface ClientOptions {
  baseUrl: string
  /**
   * A function is called per request, for credentials that expire.
   */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>)
  fetch?: typeof fetch
  middleware?: ClientMiddleware[]
  timeout?: number
  throwOnError?: boolean
  querySerializer?: (query: Record<string, unknown>) => string
  bodySerializer?: (body: unknown) => { body: BodyInit; contentType?: string }
}

type HeadersInit = NonNullable<ConstructorParameters<typeof Headers>[0]>
type BodyInit = NonNullable<ConstructorParameters<typeof Response>[0]>

export type { BodyInit, HeadersInit }
