/**
 * Public types for `@plushveil/api/server`.
 */

import type { Document, ParameterLocation } from '../openapi/main.ts'
import type { Schema } from '../schema/main.ts'
import type { State } from './main.ts'

/**
 * `HeadersInit` and `BodyInit` are not global under this project's tsconfig: `lib` is `ES2022`
 * with no DOM, and `@types/node` declares `Headers`, `Request` and `Response` but not those two
 * aliases. Recovering them from the constructors keeps us off the DOM lib.
 */
export type HeadersInit = NonNullable<ConstructorParameters<typeof Headers>[0]>
export type BodyInit = NonNullable<ConstructorParameters<typeof Response>[0]>

/**
 * Wraps a response body in an explicit media type.
 */
export interface Content<M extends string, T> {
  readonly mediaType: M
  readonly body: T
}

/**
 * The shape a route module's `Operation` interface may take.
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
 * Derives a handler's `request` from an operation.
 *
 * Presence is tested with `'k' extends keyof Op` rather than by inspecting `Op['k']`, because an
 * absent key resolves to `unknown` — not `never` — so `[Op['body']] extends [never]` is false and
 * every body-less operation would otherwise be handed a required `body: unknown`.
 */
export type HandlerRequest<Op extends OperationShape> = {
  method: string
  url: URL
  headers: Headers
  cookies: Map<string, string>
} & ('path' extends keyof Op ? { path: Op['path'] } : { path?: undefined }) &
  ('query' extends keyof Op ? { query: Op['query'] } : { query?: undefined }) &
  ('cookies' extends keyof Op ? { cookieParams: Op['cookies'] } : { cookieParams?: undefined }) &
  ('body' extends keyof Op ? ([Op['body']] extends [never] ? { body?: undefined } : { body: Op['body'] }) : { body?: undefined })

/**
 * Unwraps `Content<M, T>` to the payload a handler actually returns.
 */
export type Payload<T> = T extends Content<string, infer B> ? B : T

/**
 * One permitted return value, derived from a single declared status.
 */
export type ResponseFor<Op extends OperationShape, S extends keyof Op['responses']> = [Op['responses'][S]] extends [never]
  ? { status: S; body?: undefined; headers?: Record<string, string> }
  : { status: S; body: Payload<Op['responses'][S]>; headers?: Record<string, string> }

/**
 * The union of everything a handler for `Op` may return.
 */
export type HandlerResult<Op extends OperationShape> = { [S in keyof Op['responses']]: ResponseFor<Op, S> }[keyof Op['responses']]

/**
 * A route handler. `context` carries everything not derived from the operation.
 */
export type Handler<Op extends OperationShape = OperationShape> = (request: HandlerRequest<Op>, context: Context) => HandlerResult<Op> | Promise<HandlerResult<Op>>

/**
 * A handler as the router stores it, with the operation-derived typing erased.
 *
 * `RequestContext` rather than `never`: a `never` parameter is uncallable, which forced the one
 * place that invokes it to cast the function back into existence.
 */
export type AnyHandler = (request: RequestContext, context: Context) => unknown

/**
 * Middleware wraps the handler and everything nested inside it.
 */
export type Middleware = (context: Context, next: () => Promise<void>) => Promise<void> | void

export interface RequestContext {
  method: string
  url: URL
  headers: Headers
  cookies: Map<string, string>
  path: Record<string, unknown>
  query: Record<string, unknown>
  body: unknown
  /**
   * The unparsed Node message. Absent when the request arrived through `server.fetch`.
   */
  raw?: unknown
}

export interface ResponseContext {
  status: number
  headers: Headers
  body: unknown
}

/**
 * What matched, for logging and error reporting.
 */
export interface OperationInfo {
  method: string
  path: string
  /**
   * Only available when a `spec` is configured: `@operationId` is erased at runtime.
   */
  operationId?: string
  file?: string
}

export interface Context {
  request: RequestContext
  response: ResponseContext
  state: State & Record<string, unknown>
  operation?: OperationInfo
  signal: AbortSignal
  /**
   * Set by the server that is driving this request.
   */
  runtime?: Runtime
}

/**
 * A response a handler or `onError` may return.
 */
export type ResponseLike = Response | { status: number; body?: unknown; headers?: Record<string, string> }

export interface ValidateOptions {
  request?: boolean | 'strict'
  response?: boolean | 'warn'
  coerce?: boolean
}

export interface ServerOptions {
  routes?: string | Router
  spec?: string | Document
  validate?: boolean | ValidateOptions
  basePath?: string
  middleware?: Middleware[]
  onError?: (error: unknown, context: Context) => ResponseLike | Promise<ResponseLike>
  notFound?: AnyHandler
  bodyLimit?: number
  trustProxy?: boolean
}

/**
 * Internal per-server state shared by the router and the dispatcher.
 */
export interface Runtime {
  options: ServerOptions
  basePath: string
  validate: Required<ValidateOptions> | undefined
  spec: SpecIndex | undefined
  middleware: Middleware[]
  onError: NonNullable<ServerOptions['onError']>
  notFound: AnyHandler
}

/**
 * One operation from a loaded spec, prepared for validation.
 */
export interface IndexedOperation {
  operationId?: string
  parameters: { name: string; in: ParameterLocation; required: boolean; schema?: Schema }[]
  requestBody?: { required: boolean; schema?: Schema }
  responses: Map<string, Schema | undefined>
}

export type SpecIndex = Map<string, IndexedOperation>

/**
 * A registered route.
 */
export interface Route {
  method: string
  /**
   * The matcher's pattern, which marks a catch-all: `/files/{...rest}`.
   * Distinct from `path` because the spec has no notion of a catch-all.
   */
  pattern: string
  /**
   * The spec-facing path: `/files/{rest}`.
   */
  path: string
  segments: Segment[]
  middleware: Middleware[]
  file?: string
  handler?: AnyHandler
  load?: () => Promise<AnyHandler>
}

export type Segment = { kind: 'static'; value: string } | { kind: 'param'; name: string } | { kind: 'catchAll'; name: string }

/**
 * Options for the internal, object-form `add`, which `loadRoutes` uses.
 */
export interface AddOptions {
  handler?: AnyHandler
  load?: () => Promise<AnyHandler>
  middleware?: Middleware[]
  file?: string
}

/**
 * Hooks that run inside the middleware chain, around the handler. Validation uses these: it needs
 * the parameters a match produced, and it must run *before* the handler so coercion is visible to
 * it — but still inside the chain, so failures unwind through middleware normally.
 */
export interface HandleHooks {
  beforeHandler?: (context: Context) => Promise<void> | void
  afterHandler?: (context: Context) => Promise<void> | void
}

export interface Router {
  use: (middleware: Middleware) => Router
  add: (method: string, path: string, handler: AnyHandler | AddOptions, options?: AddOptions) => Router
  mount: (prefix: string, router: Router) => Router
  match: (method: string, pathname: string) => { route: Route; path: Record<string, string> } | undefined
  handle: (context: Context, hooks?: HandleHooks) => Promise<void>
  readonly routes: readonly Route[]
  readonly middleware: readonly Middleware[]
}

export type { Problem } from '../schema/main.ts'
