/**
 * A dependency-free validator for the JSON Schema subset documented in
 * docs/CONTRIBUTING/TYPE_MAPPING.md.
 *
 * This package is imported by both `src/server` (to validate requests at runtime) and the CLIs
 * (to check a document they were handed), so it must not reach for `node:*`, `fetch`, or
 * `typescript`. See docs/CONTRIBUTING/ARCHITECTURE.md.
 */

import type { Check, Problem, Schema, SchemaType, Validator } from './types.ts'

export type { Check, Json, Problem, Schema, SchemaType, Validator } from './types.ts'

/**
 * Thrown at compile time for a keyword outside the supported subset.
 */
export class UnsupportedKeywordError extends Error {
  readonly pointer: string
  readonly keyword: string

  constructor(pointer: string, keyword: string) {
    super(`Unsupported JSON Schema keyword ${JSON.stringify(keyword)} at ${pointer || '#'}`)
    this.name = 'UnsupportedKeywordError'
    this.pointer = pointer
    this.keyword = keyword
  }
}

/**
 * Keywords the validator enforces. Anything absent from both this set and ANNOTATIONS is a
 * compile-time error, so nothing is ever silently ignored.
 */
const ENFORCED = new Set([
  '$ref',
  'type',
  'format',
  'enum',
  'const',
  'items',
  'prefixItems',
  'properties',
  'required',
  'additionalProperties',
  'oneOf',
  'allOf',
  'anyOf',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
])

/**
 * Keywords that carry documentation rather than constraints. These are explicit no-ops: throwing
 * on them would reject the very documents `api-port` emits, which annotate freely.
 */
const ANNOTATIONS = new Set(['title', 'description', 'default', 'example', 'examples', 'deprecated', 'readOnly', 'writeOnly', '$comment', 'contentMediaType', 'xml', 'externalDocs'])

/**
 * Format checkers. An unrecognised format passes: it is carried to the spec but not enforced.
 */
const FORMATS: Record<string, (value: unknown) => boolean> = {
  'date-time': (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)),
  date: (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v),
  time: (v) => typeof v === 'string' && /^\d{2}:\d{2}:\d{2}/.test(v),
  email: (v) => typeof v === 'string' && /^[^\s@]+@[^\s@.]+\.[^\s@]+$/u.test(v),
  uuid: (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  uri: (v) => typeof v === 'string' && /^[a-z][a-z0-9+.-]*:/i.test(v),
  hostname: (v) => typeof v === 'string' && /^[a-z0-9.-]+$/i.test(v),
  ipv4: (v) => typeof v === 'string' && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(v),
  int32: (v) => Number.isInteger(v),
  int64: (v) => Number.isInteger(v),
}

/**
 * The JSON type name of a runtime value, in JSON Schema's vocabulary.
 */
function typeOf(value: unknown): SchemaType | 'undefined' {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const t = typeof value
  if (t === 'string' || t === 'boolean') return t
  if (t === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  if (t === 'object') return 'object'
  return 'undefined'
}

function matchesType(value: unknown, expected: SchemaType): boolean {
  const actual = typeOf(value)
  if (expected === 'number') return actual === 'number' || actual === 'integer'
  return actual === expected
}

/**
 * True for a JSON object, as opposed to an array or a primitive.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  if (!isRecord(a) || !isRecord(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => deepEqual(a[k], b[k]))
}

function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1')
}

/**
 * Resolves an internal `#/a/b` pointer against a document root.
 */
export function resolvePointer(root: unknown, pointer: string): unknown {
  if (pointer === '#' || pointer === '') return root
  if (!pointer.startsWith('#/')) throw new Error(`Only internal JSON Pointers are supported, got ${JSON.stringify(pointer)}`)
  let node: unknown = root
  for (const raw of pointer.slice(2).split('/')) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!isRecord(node)) return undefined
    node = node[token]
  }
  return node
}

export interface CompileOptions {
  /**
   * Document the schema belongs to, used to resolve internal `$ref`s.
   */
  root?: unknown
  /**
   * Pointer to this schema, used in error messages.
   */
  pointer?: string
}

/**
 * Compiles a schema into a validator. Every unsupported keyword is reported here rather than on
 * the request that happens to reach it.
 */
export function compile(schema: Schema, options: CompileOptions = {}): Validator {
  const root = options.root ?? schema
  const cache = new Map<Schema, Check>()
  const check = build(schema, options.pointer ?? '#', root, cache)
  return (value) => check(value, '')
}

function build(schema: Schema, pointer: string, root: unknown, cache: Map<Schema, Check>): Check {
  const cached = cache.get(schema)
  if (cached) return cached

  // Placeholder first, so a schema that refers to itself resolves rather than recursing forever.
  const holder: { check?: Check } = {}
  const lazy: Check = (value, at) => holder.check?.(value, at) ?? []
  cache.set(schema, lazy)

  holder.check = assemble(schema, pointer, root, cache)
  return lazy
}

function assemble(schema: Schema, pointer: string, root: unknown, cache: Map<Schema, Check>): Check {
  for (const keyword of Object.keys(schema)) {
    if (!ENFORCED.has(keyword) && !ANNOTATIONS.has(keyword)) throw new UnsupportedKeywordError(pointer, keyword)
  }

  if (schema.$ref !== undefined) {
    const target = resolvePointer(root, schema.$ref)
    if (target === null || typeof target !== 'object') throw new Error(`Cannot resolve $ref ${JSON.stringify(schema.$ref)} at ${pointer}`)
    return build(target, schema.$ref, root, cache)
  }

  const checks: Check[] = []

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type]
    checks.push((value, at) => (expected.some((t) => matchesType(value, t)) ? [] : [{ path: at, message: `must be ${expected.join(' or ')}` }]))
  }

  if (schema.const !== undefined) {
    const expected = schema.const
    checks.push((value, at) => (deepEqual(value, expected) ? [] : [{ path: at, message: `must be ${JSON.stringify(expected)}` }]))
  }

  if (schema.enum !== undefined) {
    const allowed = schema.enum
    checks.push((value, at) => (allowed.some((a) => deepEqual(value, a)) ? [] : [{ path: at, message: `must be one of ${allowed.map((a) => JSON.stringify(a)).join(', ')}` }]))
  }

  if (schema.format !== undefined) {
    const { format } = schema
    const checker = FORMATS[format]
    if (checker) {
      checks.push((value, at) => (value === undefined || checker(value) ? [] : [{ path: at, message: `must match format ${JSON.stringify(format)}` }]))
    }
  }

  checks.push(...stringChecks(schema))
  checks.push(...numberChecks(schema))
  checks.push(...arrayChecks(schema, pointer, root, cache))
  checks.push(...objectChecks(schema, pointer, root, cache))
  checks.push(...combinatorChecks(schema, pointer, root, cache))

  if (checks.length === 1) return checks[0]
  return (value, at) => checks.flatMap((c) => c(value, at))
}

function stringChecks(schema: Schema): Check[] {
  const out: Check[] = []
  const { minLength, maxLength, pattern } = schema

  // Guard on the runtime type, not the declared one: `type` is the only source of type problems,
  // so a wrong type must not also be reported as a length failure.
  if (minLength !== undefined) out.push((v, at) => (typeof v === 'string' && v.length < minLength ? [{ path: at, message: `must be at least ${minLength} characters` }] : []))
  if (maxLength !== undefined) out.push((v, at) => (typeof v === 'string' && v.length > maxLength ? [{ path: at, message: `must be at most ${maxLength} characters` }] : []))
  if (pattern !== undefined) {
    const re = new RegExp(pattern)
    out.push((v, at) => (typeof v === 'string' && !re.test(v) ? [{ path: at, message: `must match pattern ${JSON.stringify(pattern)}` }] : []))
  }
  return out
}

function numberChecks(schema: Schema): Check[] {
  const out: Check[] = []
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf } = schema
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

  if (minimum !== undefined) out.push((v, at) => (num(v) && v < minimum ? [{ path: at, message: `must be >= ${minimum}` }] : []))
  if (maximum !== undefined) out.push((v, at) => (num(v) && v > maximum ? [{ path: at, message: `must be <= ${maximum}` }] : []))
  if (exclusiveMinimum !== undefined) out.push((v, at) => (num(v) && v <= exclusiveMinimum ? [{ path: at, message: `must be > ${exclusiveMinimum}` }] : []))
  if (exclusiveMaximum !== undefined) out.push((v, at) => (num(v) && v >= exclusiveMaximum ? [{ path: at, message: `must be < ${exclusiveMaximum}` }] : []))
  if (multipleOf !== undefined) out.push((v, at) => (num(v) && multipleOf > 0 && Math.abs(v / multipleOf - Math.round(v / multipleOf)) > 1e-9 ? [{ path: at, message: `must be a multiple of ${multipleOf}` }] : []))
  return out
}

function arrayChecks(schema: Schema, pointer: string, root: unknown, cache: Map<Schema, Check>): Check[] {
  const out: Check[] = []
  const { minItems, maxItems, uniqueItems, items, prefixItems } = schema

  if (minItems !== undefined) out.push((v, at) => (Array.isArray(v) && v.length < minItems ? [{ path: at, message: `must have at least ${minItems} items` }] : []))
  if (maxItems !== undefined) out.push((v, at) => (Array.isArray(v) && v.length > maxItems ? [{ path: at, message: `must have at most ${maxItems} items` }] : []))
  if (uniqueItems === true) {
    out.push((v, at) => {
      if (!Array.isArray(v)) return []
      const dupe = v.some((x, i) => v.slice(i + 1).some((y) => deepEqual(x, y)))
      return dupe ? [{ path: at, message: 'must not contain duplicate items' }] : []
    })
  }

  const prefix = prefixItems?.map((s, i) => build(s, `${pointer}/prefixItems/${i}`, root, cache))
  if (prefix) {
    out.push((v, at) => (Array.isArray(v) ? prefix.flatMap((c, i) => (i < v.length ? c(v[i], `${at}/${i}`) : [])) : []))
  }

  if (items === false) {
    const allowed = prefixItems?.length ?? 0
    out.push((v, at) => (Array.isArray(v) && v.length > allowed ? [{ path: at, message: `must have at most ${allowed} items` }] : []))
  } else if (items !== undefined) {
    const item = build(items, `${pointer}/items`, root, cache)
    const from = prefixItems?.length ?? 0
    out.push((v, at) => (Array.isArray(v) ? v.slice(from).flatMap((x, i) => item(x, `${at}/${from + i}`)) : []))
  }

  return out
}

function objectChecks(schema: Schema, pointer: string, root: unknown, cache: Map<Schema, Check>): Check[] {
  const out: Check[] = []
  const { properties, required, additionalProperties, minProperties, maxProperties } = schema
  const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

  if (required !== undefined && required.length > 0) {
    out.push((v, at) => (isPlain(v) ? required.filter((k) => v[k] === undefined).map((k) => ({ path: `${at}/${escapeToken(k)}`, message: 'is required' })) : []))
  }

  if (minProperties !== undefined) out.push((v, at) => (isPlain(v) && Object.keys(v).length < minProperties ? [{ path: at, message: `must have at least ${minProperties} properties` }] : []))
  if (maxProperties !== undefined) out.push((v, at) => (isPlain(v) && Object.keys(v).length > maxProperties ? [{ path: at, message: `must have at most ${maxProperties} properties` }] : []))

  const compiled = properties ? new Map(Object.entries(properties).map(([key, s]) => [key, build(s, `${pointer}/properties/${escapeToken(key)}`, root, cache)])) : undefined

  if (compiled) {
    out.push((v, at) => {
      if (!isPlain(v)) return []
      const problems: Problem[] = []
      for (const [key, c] of compiled) {
        if (v[key] !== undefined) problems.push(...c(v[key], `${at}/${escapeToken(key)}`))
      }
      return problems
    })
  }

  if (additionalProperties === false) {
    const known = new Set(properties ? Object.keys(properties) : [])
    out.push((v, at) =>
      isPlain(v)
        ? Object.keys(v)
            .filter((k) => !known.has(k))
            .map((k) => ({ path: `${at}/${escapeToken(k)}`, message: 'is not allowed' }))
        : [],
    )
  } else if (typeof additionalProperties === 'object' && additionalProperties !== null) {
    const extra = build(additionalProperties, `${pointer}/additionalProperties`, root, cache)
    const known = new Set(properties ? Object.keys(properties) : [])
    out.push((v, at) => {
      if (!isPlain(v)) return []
      return Object.keys(v)
        .filter((k) => !known.has(k))
        .flatMap((k) => extra(v[k], `${at}/${escapeToken(k)}`))
    })
  }

  return out
}

function combinatorChecks(schema: Schema, pointer: string, root: unknown, cache: Map<Schema, Check>): Check[] {
  const out: Check[] = []

  if (schema.allOf) {
    const all = schema.allOf.map((s, i) => build(s, `${pointer}/allOf/${i}`, root, cache))
    out.push((v, at) => all.flatMap((c) => c(v, at)))
  }

  if (schema.anyOf) {
    const any = schema.anyOf.map((s, i) => build(s, `${pointer}/anyOf/${i}`, root, cache))
    out.push((v, at) => (any.some((c) => c(v, at).length === 0) ? [] : [{ path: at, message: 'must match at least one of the permitted schemas' }]))
  }

  if (schema.oneOf) {
    const one = schema.oneOf.map((s, i) => build(s, `${pointer}/oneOf/${i}`, root, cache))
    out.push((v, at) => {
      const matched = one.filter((c) => c(v, at).length === 0).length
      if (matched === 1) return []
      return [{ path: at, message: matched === 0 ? 'must match one of the permitted schemas' : 'must match exactly one of the permitted schemas' }]
    })
  }

  return out
}

/**
 * Coerces a parameter value, which always arrives as a string, to the type its schema declares.
 * Request bodies are never coerced. A value that cannot be coerced is returned unchanged so the
 * validator reports it, rather than being silently replaced.
 */
export function coerce(schema: Schema, raw: string | string[] | undefined): unknown {
  if (raw === undefined) return undefined

  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type

  if (type === 'array') {
    const values = Array.isArray(raw) ? raw : [raw]
    const item = typeof schema.items === 'object' ? schema.items : undefined
    return item ? values.map((v) => coerce(item, v)) : values
  }

  const value = Array.isArray(raw) ? raw[0] : raw
  if (value === undefined) return undefined

  switch (type) {
    case 'boolean':
      if (value === 'true' || value === '') return true
      if (value === 'false') return false
      return value
    case 'integer':
    case 'number': {
      if (value.trim() === '') return value
      const n = Number(value)
      if (!Number.isFinite(n)) return value
      if (type === 'integer' && !Number.isInteger(n)) return value
      return n
    }
    case 'null':
      return value === 'null' || value === '' ? null : value
    default:
      return value
  }
}
