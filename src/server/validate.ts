/**
 * Runtime validation against a generated `openapi.json`.
 *
 * A route module's `Operation` interface is erased at compile time, so the spec is the only thing
 * the running process can validate against. This is why the CLIs matter to the server itself.
 * See docs/CONTRIBUTING/ARCHITECTURE.md.
 */

import { isMethod, type Document } from '../openapi/main.ts'
import { coerce, compile, type Problem, type Schema } from '../schema/main.ts'
import { ValidationError } from './errors.ts'
import type { Context, Runtime, SpecIndex, ValidateOptions } from './types.ts'

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

      const bodySchema = operation.requestBody?.content?.['application/json']?.schema
      const responses = new Map<string, Schema | undefined>()
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        responses.set(status, response.content?.['application/json']?.schema)
      }

      const key = `${method.toUpperCase()} ${base}${path}`
      index.set(key, {
        operationId: operation.operationId,
        parameters,
        requestBody: operation.requestBody ? { required: operation.requestBody.required ?? false, schema: bodySchema } : undefined,
        responses,
      })

      // Compiling here surfaces an unsupported keyword at startup, naming the operation, rather
      // than on whichever request happens to reach it.
      for (const parameter of parameters) if (parameter.schema) compile(parameter.schema, { root: document, pointer: key })
      if (bodySchema) compile(bodySchema, { root: document, pointer: key })
      for (const schema of responses.values()) if (schema) compile(schema, { root: document, pointer: key })
    }
  }

  return index
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
    } else if (found.requestBody.schema) {
      const check = compile(found.requestBody.schema, { root: document })
      for (const problem of check(body)) problems.push({ in: 'body', path: problem.path, message: problem.message })
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

  const schema = found.responses.get(String(context.response.status)) ?? found.responses.get('default')
  if (!schema) return []

  return compile(schema, { root: document })(context.response.body)
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
