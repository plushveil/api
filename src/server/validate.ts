/**
 * Runtime validation against a generated `openapi.json`.
 *
 * A route module's `Operation` interface is erased at compile time, so the spec is the only thing
 * the running process can validate against. This is why the CLIs matter to the server itself.
 * See docs/CONTRIBUTING/ARCHITECTURE.md.
 */

import { isMethod, type Document, type MediaTypeObject } from '../openapi/main.ts'
import { coerce, compile, type Problem } from '../schema/main.ts'
import { UnsupportedMediaTypeError, ValidationError } from './errors.ts'
import type { Context, IndexedMediaType, IndexedOperation, Runtime, SpecIndex, ValidateOptions } from './types.ts'

/**
 * Converts a `content` map (`requestBody.content`, or one status's `responses[status].content`)
 * into the form validation and body reading share.
 */
function mediaMap(content: Record<string, MediaTypeObject> | undefined): Map<string, IndexedMediaType> {
  const map = new Map<string, IndexedMediaType>()
  for (const [mediaType, media] of Object.entries(content ?? {})) map.set(mediaType, { schema: media.schema, stream: media['x-stream'] === true })
  return map
}

/**
 * Indexes a document by `METHOD /path`, compiling every schema up front.
 */
export function indexSpec(document: Document, basePath: string): SpecIndex {
  const index: SpecIndex = new Map()
  const base = basePath === '/' ? '' : basePath.replace(/\/$/, '')

  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      if (!isMethod(method) || !operation) continue

      const parameters = (operation.parameters ?? []).map((p) => ({
        name: p.name,
        in: p.in,
        required: p.required ?? p.in === 'path',
        schema: p.schema,
      }))

      const requestContent = mediaMap(operation.requestBody?.content)
      const responses = new Map<string, Map<string, IndexedMediaType>>()
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        responses.set(status, mediaMap(response.content))
      }

      const key = `${method.toUpperCase()} ${base}${path}`
      index.set(key, {
        operationId: operation.operationId,
        parameters,
        requestBody: operation.requestBody ? { required: operation.requestBody.required ?? false, content: requestContent } : undefined,
        responses,
      })

      // Compiling here surfaces an unsupported keyword at startup, naming the operation, rather
      // than on whichever request happens to reach it.
      for (const parameter of parameters) if (parameter.schema) compile(parameter.schema, { root: document, pointer: key })
      for (const media of requestContent.values()) if (media.schema) compile(media.schema, { root: document, pointer: key })
      for (const statusMedia of responses.values()) for (const media of statusMedia.values()) if (media.schema) compile(media.schema, { root: document, pointer: key })
    }
  }

  return index
}

/**
 * Looks up a route's indexed operation directly, ahead of a match reaching `context.operation` --
 * `dispatch.ts` needs this before it can decide how to read the body, which happens before the
 * router has set `context.operation` for this request.
 */
export function findOperation(runtime: Runtime, method: string, path: string): IndexedOperation | undefined {
  const index = runtime.spec
  if (!index) return undefined
  const base = runtime.basePath === '/' ? '' : runtime.basePath
  return index.get(`${method} ${base}${path}`)
}

/**
 * The request's content type, ignoring parameters (`; boundary=...`, `; charset=...`). Bodyless
 * requests and requests with no header both resolve to `application/json`, matching how a spec
 * with one JSON-only media type has always been read.
 */
function requestMediaType(context: Context): string {
  const type = context.request.headers.get('content-type')
  return type ? type.split(';')[0].trim() || 'application/json' : 'application/json'
}

/**
 * Normalises the `validate` option.
 */
export function resolveValidateOptions(validate: boolean | ValidateOptions | undefined): Required<ValidateOptions> | undefined {
  if (!validate) return undefined
  if (validate === true) return { request: true, response: false, coerce: true }
  return {
    request: validate.request ?? true,
    response: validate.response ?? false,
    coerce: validate.coerce ?? true,
  }
}

/**
 * The spec is indexed with `basePath` applied, while routes are stored without it. Applying it
 * in exactly one place is what keeps every lookup from missing and silently disabling validation.
 */
function specKey(runtime: Runtime, context: Context): string {
  const path = context.operation?.path ?? ''
  const base = runtime.basePath === '/' ? '' : runtime.basePath
  return `${context.operation?.method} ${base}${path}`
}

function bagFor(context: Context, location: string): Record<string, unknown> | undefined {
  if (location === 'path') return context.request.path
  if (location === 'query') return context.request.query
  return undefined
}

/**
 * Validates the request. Parameters arrive as strings, so coercion is what makes a declared
 * `number` actually be one in the handler.
 *
 * Only headers are matched case-insensitively — `API_FOLDER.md` grants that to headers alone, so
 * lowercasing query or cookie names would let `?userid=1` satisfy a `userId` parameter.
 */
export function validateRequest(runtime: Runtime, context: Context, document: Document): void {
  const { validate } = runtime
  const index = runtime.spec
  if (!validate || !validate.request || !index || !context.operation) return

  const found = index.get(specKey(runtime, context))
  if (!found) return

  // The only runtime source for operationId: `@operationId` is a JSDoc comment, erased by then.
  context.operation.operationId = found.operationId
  const problems: Problem[] = []

  for (const parameter of found.parameters) {
    const raw = readParameter(context, parameter)
    if (raw === undefined) {
      if (parameter.required) problems.push({ in: parameter.in, path: `/${parameter.name}`, message: 'is required' })
      continue
    }

    let value: unknown = raw
    if (validate.coerce && parameter.schema) {
      value = coerce(parameter.schema, raw)
      const bag = bagFor(context, parameter.in)
      if (bag) bag[parameter.name] = value
    }

    if (parameter.schema) {
      const check = compile(parameter.schema, { root: document })
      for (const problem of check(value)) {
        problems.push({ in: parameter.in, path: `/${parameter.name}${problem.path}`, message: problem.message })
      }
    }
  }

  if (found.requestBody) {
    const { body } = context.request
    if (body === undefined) {
      if (found.requestBody.required) problems.push({ in: 'body', path: '', message: 'is required' })
    } else {
      const type = requestMediaType(context)
      const media = found.requestBody.content.get(type)
      if (!media) throw new UnsupportedMediaTypeError(type, [...found.requestBody.content.keys()])
      // A byte payload -- buffered (`Uint8Array`, from a declared or undeclared binary media type)
      // or streamed (`media.stream`, left unread) -- cannot be checked against a JSON schema.
      if (media.schema && !media.stream && !(body instanceof Uint8Array)) {
        const check = compile(media.schema, { root: document })
        for (const problem of check(body)) problems.push({ in: 'body', path: problem.path, message: problem.message })
      }
    }
  }

  if (problems.length > 0) throw new ValidationError(problems)
}

/**
 * Renders a parameter value as text. Only a primitive has an unambiguous textual form; an object
 * would become '[object Object]' and then validate against nothing meaningful.
 */
function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value) ?? ''
}

function readParameter(context: Context, parameter: { name: string; in: string }): string | string[] | undefined {
  switch (parameter.in) {
    case 'path': {
      const value = context.request.path[parameter.name]
      return typeof value === 'string' ? value : undefined
    }
    case 'query': {
      const value = context.request.query[parameter.name]
      if (value === undefined) return undefined
      // Only a primitive has an unambiguous textual form; an object would become
      // '[object Object]' and validate against nothing meaningful.
      if (Array.isArray(value)) return value.map(asText)
      return asText(value)
    }
    case 'header':
      // Already case-insensitive by construction.
      return context.request.headers.get(parameter.name) ?? undefined
    case 'cookie':
      return context.request.cookies.get(parameter.name)
    default:
      return undefined
  }
}

/**
 * Validates the response body, when asked.
 */
export function validateResponse(runtime: Runtime, context: Context, document: Document): Problem[] {
  const { validate } = runtime
  const index = runtime.spec
  if (!validate || !validate.response || !index || !context.operation) return []

  const found = index.get(specKey(runtime, context))
  if (!found) return []

  const statusMedia = found.responses.get(String(context.response.status)) ?? found.responses.get('default')
  if (!statusMedia) return []

  // The handler's own `content-type`, defaulting to JSON as an unset header always has -- a
  // handler returning a `Content<M, T>` response sets its media type via `headers`, applied by
  // `applyResult` before this runs (see `router.ts`).
  const type = context.response.headers.get('content-type')?.split(';')[0].trim() || 'application/json'
  const media = statusMedia.get(type)
  if (!media?.schema || media.stream || context.response.body instanceof Uint8Array) return []

  return compile(media.schema, { root: document })(context.response.body)
}

/**
 * Warns about routes the spec does not describe. A route with no operation is served unvalidated;
 * under `validate.request: 'strict'` it is a startup error instead.
 */
export function checkCoverage(index: SpecIndex, routes: readonly { method: string; path: string }[], strict: boolean): string[] {
  const missing = routes.filter((route) => !index.has(`${route.method} ${route.path}`)).map((route) => `${route.method} ${route.path}`)
  if (missing.length > 0 && strict) {
    throw new Error(`These routes have no operation in the specification: ${missing.join(', ')}`)
  }
  return missing
}
