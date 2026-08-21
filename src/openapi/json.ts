/**
 * Reading and writing OpenAPI documents as bytes.
 *
 * The writer runs in two stages: `canonicalize` turns the model into an intermediate
 * representation whose objects are **arrays of entries**, then `encode` prints that. The
 * intermediate step is not decoration — JavaScript objects hoist integer-like keys into numeric
 * order regardless of insertion order, so `{ '404': …, '200': … }` cannot express "404 first"
 * even if we wanted it to. Once the entries are in an array, the order is ours.
 *
 * `JSON.stringify` is used only on individual scalars and keys, never on a subtree, because it
 * would reintroduce that hoisting.
 */

import {
  byTemplate,
  COMPONENTS_KEYS,
  compareCodePoints,
  compareEnumMembers,
  compareParameters,
  compareStatuses,
  DOCUMENT_KEYS,
  INFO_KEYS,
  OPERATION_KEYS,
  PARAMETER_KEYS,
  REQUEST_BODY_KEYS,
  RESPONSE_KEYS,
  SCHEMA_KEYS,
  SERVER_KEYS,
  sorted,
} from './order.ts'
import { isMethod, METHODS, type Document } from './types.ts'

/**
 * Raised for a document this build cannot read or write.
 */
export class SpecError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpecError'
  }
}

type Node = { kind: 'scalar'; text: string } | { kind: 'array'; items: Node[] } | { kind: 'object'; entries: [string, Node][] }

function scalar(value: unknown): Node {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SpecError(`Cannot encode the non-finite number ${String(value)}`)
    // Normalise negative zero, which JSON.stringify prints as `0` but which compares unequal.
    return { kind: 'scalar', text: JSON.stringify(value === 0 ? 0 : value) }
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return { kind: 'scalar', text: JSON.stringify(value) }
  throw new SpecError(`Cannot encode a value of type ${typeof value}`)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Canonicalises a subtree this build does not model: keys by code point, arrays as written.
 */
function canonicalJson(value: unknown): Node {
  if (Array.isArray(value)) return { kind: 'array', items: value.filter((v) => v !== undefined).map(canonicalJson) }
  if (isPlainObject(value)) {
    const keys = sorted(
      Object.keys(value).filter((k) => value[k] !== undefined),
      compareCodePoints,
    )
    return { kind: 'object', entries: keys.map((k) => [k, canonicalJson(value[k])]) }
  }
  return scalar(value)
}

/**
 * Everything below walks `unknown` and narrows with predicates rather than casting the typed model
 * to a record. The model describes what an author writes; the writer only has to serialise whatever
 * is actually there, and a hand-written document that strays from the model should be emitted
 * faithfully rather than crash.
 *
 * Only `undefined` is dropped. `{}` and `[]` are meaningful: `unknown` maps to `{}`, `unknown[]` to
 * `items: {}`, and `Record<string, unknown>` to `additionalProperties: {}`, so absence would change
 * the meaning.
 */
function templated(value: unknown, template: string[], child: (key: string, value: unknown) => Node): Node {
  if (!isPlainObject(value)) return canonicalJson(value)
  const keys = sorted(
    Object.keys(value).filter((k) => value[k] !== undefined),
    byTemplate(template),
  )
  return { kind: 'object', entries: keys.map((k) => [k, child(k, value[k])]) }
}

/**
 * An object node whose keys are sorted by name and whose values share one canonicaliser.
 */
function keyed(value: unknown, compare: (a: string, b: string) => number, child: (value: unknown) => Node): Node {
  if (!isPlainObject(value)) return canonicalJson(value)
  const names = sorted(Object.keys(value), compare)
  return { kind: 'object', entries: names.map((name) => [name, child(value[name])]) }
}

/**
 * An array node, sorted when a comparator is given.
 */
function listed(value: unknown, child: (value: unknown) => Node, compare?: (a: unknown, b: unknown) => number): Node {
  if (!Array.isArray(value)) return canonicalJson(value)
  const items = compare ? sorted(value, compare) : value
  return { kind: 'array', items: items.map(child) }
}

function canonicalSchema(value: unknown): Node {
  return templated(value, SCHEMA_KEYS, (key, child) => {
    switch (key) {
      case 'properties':
        return keyed(child, compareCodePoints, canonicalSchema)
      case 'required':
        return listed(child, scalar, (a, b) => compareCodePoints(String(a), String(b)))
      case 'enum':
        return listed(child, scalar, compareEnumMembers)
      case 'items':
      case 'additionalProperties':
        return typeof child === 'boolean' ? scalar(child) : canonicalSchema(child)
      // Order is significant for a tuple, and meaningful to a reader for the combinators.
      case 'prefixItems':
      case 'oneOf':
      case 'allOf':
      case 'anyOf':
        return listed(child, canonicalSchema)
      default:
        return canonicalJson(child)
    }
  })
}

function canonicalContent(value: unknown): Node {
  return keyed(value, compareCodePoints, (media) => templated(media, ['schema'], (_key, schema) => canonicalSchema(schema)))
}

function canonicalParameter(value: unknown): Node {
  return templated(value, PARAMETER_KEYS, (key, child) => (key === 'schema' ? canonicalSchema(child) : canonicalJson(child)))
}

/**
 * Parameters sort by location then name, which needs the objects rather than their keys.
 */
function compareParameterValues(a: unknown, b: unknown): number {
  if (!isPlainObject(a) || !isPlainObject(b)) return 0
  return compareParameters({ name: String(a.name), in: String(a.in) }, { name: String(b.name), in: String(b.in) })
}

function canonicalOperation(value: unknown): Node {
  return templated(value, OPERATION_KEYS, (key, child) => {
    switch (key) {
      case 'tags':
        return listed(child, scalar, (a, b) => compareCodePoints(String(a), String(b)))
      case 'parameters':
        return listed(child, canonicalParameter, compareParameterValues)
      case 'requestBody':
        return templated(child, REQUEST_BODY_KEYS, (k, v) => (k === 'content' ? canonicalContent(v) : canonicalJson(v)))
      case 'responses':
        return keyed(child, compareStatuses, (response) => templated(response, RESPONSE_KEYS, (k, v) => (k === 'content' ? canonicalContent(v) : canonicalJson(v))))
      default:
        return canonicalJson(child)
    }
  })
}

function canonicalPathItem(value: unknown): Node {
  return templated(value, [...METHODS], (_method, operation) => canonicalOperation(operation))
}

function canonicalDocument(document: Document): Node {
  return templated(document, DOCUMENT_KEYS, (key, child) => {
    switch (key) {
      case 'info':
        return templated(child, INFO_KEYS, (_k, v) => canonicalJson(v))
      case 'servers':
        return listed(child, (server) => templated(server, SERVER_KEYS, (_k, v) => canonicalJson(v)))
      case 'paths':
        return keyed(child, compareCodePoints, canonicalPathItem)
      case 'components':
        return templated(child, COMPONENTS_KEYS, (k, v) => (k === 'schemas' ? keyed(v, compareCodePoints, canonicalSchema) : canonicalJson(v)))
      default:
        return canonicalJson(child)
    }
  })
}

/**
 * Matches this project's formatter so the artefact `api-port` writes is already formatted: objects
 * always expand, and an array of scalars collapses onto one line when it fits inside `printWidth`.
 * Keeping the two in step is what lets `oxfmt --check` cover generated output.
 */
const PRINT_WIDTH = 220

function encode(node: Node, indent: string): string {
  if (node.kind === 'scalar') return node.text
  const inner = `${indent}  `

  if (node.kind === 'array') {
    if (node.items.length === 0) return '[]'
    if (node.items.every((item) => item.kind === 'scalar')) {
      const line = `[${node.items.map((item) => encode(item, inner)).join(', ')}]`
      if (indent.length + line.length <= PRINT_WIDTH) return line
    }
    return `[\n${node.items.map((i) => `${inner}${encode(i, inner)}`).join(',\n')}\n${indent}]`
  }

  if (node.entries.length === 0) return '{}'
  return `{\n${node.entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${encode(v, inner)}`).join(',\n')}\n${indent}}`
}

/**
 * Serialises a document to its canonical bytes: LF endings, two-space indent, one trailing
 * newline, no BOM. Calling this twice on the same document yields identical output, and it never
 * mutates the document it is given.
 */
export function stringify(document: Document): string {
  return `${encode(canonicalDocument(document), '')}\n`
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new SpecError(`The document is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/**
 * Parses a document, rejecting anything structurally unusable rather than limping onward.
 */
export function parseDocument(text: string): Document {
  const raw = parseJson(text)
  assertDocument(raw)
  return raw
}

/**
 * Checks the structure a document must have to be usable, narrowing as it goes.
 *
 * An `asserts` signature rather than a cast: the checks below are the proof, so the type follows
 * from them instead of being claimed alongside them.
 */
function assertDocument(raw: unknown): asserts raw is Document {
  if (!isPlainObject(raw)) throw new SpecError('The document must be a JSON object')
  if (typeof raw.openapi !== 'string') throw new SpecError('The document is missing a string `openapi` version')
  if (!isPlainObject(raw.info)) throw new SpecError('The document is missing an `info` object')
  if (typeof raw.info.title !== 'string' || typeof raw.info.version !== 'string') throw new SpecError('`info` must carry a string `title` and `version`')
  if (raw.paths !== undefined && !isPlainObject(raw.paths)) throw new SpecError('`paths` must be an object')

  const paths = isPlainObject(raw.paths) ? raw.paths : {}
  for (const [path, item] of Object.entries(paths)) {
    if (!isPlainObject(item)) throw new SpecError(`Path item ${JSON.stringify(path)} must be an object`)
    for (const [method, operation] of Object.entries(item)) {
      if (!isMethod(method)) continue
      if (!isPlainObject(operation)) throw new SpecError(`Operation ${method} ${path} must be an object`)
      if (!isPlainObject(operation.responses)) throw new SpecError(`Operation ${method} ${path} must declare \`responses\``)
    }
  }
}
