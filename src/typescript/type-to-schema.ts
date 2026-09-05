/**
 * Turns a resolved TypeScript type into a JSON Schema, per docs/CONTRIBUTING/TYPE_MAPPING.md.
 *
 * Dispatch goes through the declared type guards (`isUnionType`, `isLiteralType`, …) rather than
 * raw `TypeFlags` bit tests. The exported `Type` interface deliberately exposes none of the members
 * the walk reads — `value`, `getTypes()`, `getTarget()` live on the narrowed subtypes, and the
 * class that implements them is not exported — so a guard is the only way to reach them.
 */

import type { Checker, Symbol as TsSymbol, Type } from 'typescript/unstable/sync'
import { compareCodePoints, sorted, type Json, type Schema, type SchemaType } from '../openapi/main.ts'
import { readDoc } from './jsdoc.ts'

/**
 * `SymbolFlags.Optional`. Not exported as a named member, so it is spelled out.
 */
const OPTIONAL = 1 << 24

/**
 * Raised for a type outside the supported subset. Names the file, position, and type.
 */
export class UnsupportedTypeError extends Error {
  constructor(message: string, location?: string) {
    super(location ? `${message} (${location})` : message)
    this.name = 'UnsupportedTypeError'
  }
}

/**
 * Where a registered name first came from: the file, for a collision to name both sites, and the
 * symbol's id, to tell a genuine collision (two different declarations sharing a name) from the
 * ordinary case of one shared type imported into many route files.
 */
interface Origin {
  location: string
  symbolId: number
}

/**
 * Collects named types so they can be emitted once under `components/schemas`.
 */
export interface Components {
  schemas: Map<string, Schema>
  origins: Map<string, Origin>
}

export function createComponents(): Components {
  return { schemas: new Map(), origins: new Map() }
}

export interface WalkContext {
  checker: Checker
  components: Components
  /**
   * Types currently being walked, so a recursive type becomes a `$ref` rather than recursing.
   */
  active: Set<string>
  location: (symbol?: TsSymbol) => string
}

/**
 * Reads a symbol's type, which the checker declares as possibly absent.
 */
export function typeOfSymbol(context: WalkContext, symbol: TsSymbol): Type {
  const type = context.checker.getTypeOfSymbol(symbol)
  if (!type) throw new UnsupportedTypeError(`Could not resolve the type of ${symbol.name}`, context.location(symbol))
  return type
}

function isOptional(symbol: TsSymbol): boolean {
  return (symbol.flags & OPTIONAL) !== 0
}

/**
 * The name a type should be registered under, plus the id of the symbol that named it, or
 * undefined when it is an inline literal.
 *
 * An anonymous object literal's symbol is called `__type`, so that is the discriminator. The alias
 * symbol is preferred, which is what lets `type Names = 'a' | 'b'` become a component even though
 * it is not an object type.
 *
 * The id, not just the name, is what a caller needs to register: a name alone can't tell a shared
 * type imported into many route files (every use resolves to the *same* symbol id) from two
 * unrelated declarations that happen to share a name (different ids) -- see `typeToSchema`.
 */
function namedSymbol(type: Type): { name: string; symbolId: number } | undefined {
  const symbol = type.getAliasSymbol() ?? type.getSymbol()
  if (!symbol) return undefined
  const { name } = symbol
  if (!name || name.startsWith('__')) return undefined
  // Builtins are mapped by value, never registered.
  if (name === 'Date' || name === 'Array' || name === 'Uint8Array' || name === 'Record') return undefined
  if (name === 'ArrayBuffer' || name === 'Blob' || name === 'ReadableStream') return undefined
  return { name, symbolId: symbol.id }
}

/**
 * Walks a type to a schema, registering named types as components.
 */
export function typeToSchema(context: WalkContext, type: Type, location: string): Schema {
  if (type.isErrorType()) throw new UnsupportedTypeError('The type could not be resolved by the compiler', location)

  const intrinsic = intrinsicSchema(context, type, location)
  if (intrinsic) return intrinsic

  // Hoisted above the object branch on purpose, so a named non-object alias becomes a component
  // too, as API_FOLDER.md requires.
  const named = namedSymbol(type)
  if (named) {
    const { name } = named
    const ref: Schema = { $ref: `#/components/schemas/${name}` }
    if (context.components.schemas.has(name) || context.active.has(name)) {
      const origin = context.components.origins.get(name)
      // A genuine collision is two *different* declarations sharing a name -- their symbols have
      // different ids. The ordinary case, one shared type (e.g. a schema imported from
      // schemas.ts) referenced from many route files, resolves to the same symbol every time and
      // must not trip this: `origin.location` alone can't distinguish the two, since it is a
      // different file on every use past the first regardless of which case this is.
      if (origin && origin.symbolId !== named.symbolId && !context.active.has(name)) {
        throw new UnsupportedTypeError(`Two different types are both named ${JSON.stringify(name)} (${origin.location} and ${location}); rename one`, location)
      }
      return ref
    }

    context.active.add(name)
    context.components.origins.set(name, { location, symbolId: named.symbolId })
    try {
      const schema = structural(context, type, location)
      const doc = readDoc(context.checker, type.getAliasSymbol() ?? type.getSymbol())
      if (doc.description) schema.description = doc.description
      context.components.schemas.set(name, schema)
    } finally {
      context.active.delete(name)
    }
    return ref
  }

  return structural(context, type, location)
}

/**
 * Primitives and the builtins that map to a format.
 */
function intrinsicSchema(context: WalkContext, type: Type, location: string): Schema | undefined {
  if (type.isIntrinsicType()) {
    switch (type.intrinsicName) {
      case 'string':
        return { type: 'string' }
      case 'number':
        return { type: 'number' }
      case 'bigint':
        return { type: 'integer' }
      case 'boolean':
        return { type: 'boolean' }
      case 'null':
        return { type: 'null' }
      case 'true':
        return { const: true }
      case 'false':
        return { const: false }
      case 'unknown':
      case 'any':
        return {}
      case 'void':
      case 'undefined':
      case 'never':
        return undefined
      default:
        throw new UnsupportedTypeError(`The type ${type.intrinsicName} has no JSON representation`, location)
    }
  }

  if (type.isStringLiteralType() || type.isNumberLiteralType() || type.isBooleanLiteralType()) {
    return { const: type.value as Schema['const'] }
  }

  const symbol = type.getSymbol()
  if (symbol?.name === 'Date') return { type: 'string', format: 'date-time' }
  // A raw byte payload, however it is held in memory. `Uint8Array`/`ArrayBuffer`/`Blob` are
  // buffered; `ReadableStream` is not -- but the schema cannot tell them apart, since all four
  // describe the same wire shape. The distinction is carried one level up, on the media type
  // object's `x-stream` flag (see `contentMapFor` in extract.ts), not here.
  if (symbol?.name === 'Uint8Array' || symbol?.name === 'ArrayBuffer' || symbol?.name === 'Blob' || symbol?.name === 'ReadableStream') {
    return { type: 'string', format: 'binary' }
  }

  return undefined
}

function structural(context: WalkContext, type: Type, location: string): Schema {
  if (type.isUnionType()) return unionSchema(context, type.getTypes(), location)
  if (type.isIntersectionType()) return { allOf: type.getTypes().map((t) => typeToSchema(context, t, location)) }
  if (type.isTupleType()) {
    const args = context.checker.getTypeArguments(type)
    return { type: 'array', prefixItems: args.map((t) => typeToSchema(context, t, location)), items: false }
  }
  if (type.isTypeReference() && context.checker.isArrayType(type)) {
    const [item] = context.checker.getTypeArguments(type)
    return { type: 'array', items: item ? typeToSchema(context, item, location) : {} }
  }
  if (type.isObjectType() || type.isClassOrInterface()) return objectSchema(context, type, location)

  throw new UnsupportedTypeError('The type has no JSON Schema representation', location)
}

/**
 * A union of same-typed literals collapses to `enum`; anything else becomes `oneOf`.
 *
 * `boolean` is special. TypeScript models it as `true | false`, and an *optional* boolean loses
 * `TypeFlags.Boolean`, so without collapsing the pair here every `flag?: boolean` would emit
 * `oneOf: [{ const: false }, { const: true }]`.
 */
function unionSchema(context: WalkContext, members: readonly Type[], location: string): Schema {
  const present = members.filter((m) => !(m.isIntrinsicType() && (m.intrinsicName === 'undefined' || m.intrinsicName === 'void')))
  const nullable = present.some((m) => m.isIntrinsicType() && m.intrinsicName === 'null')
  const meaningful = present.filter((m) => !(m.isIntrinsicType() && m.intrinsicName === 'null'))

  if (meaningful.length === 0) return { type: 'null' }

  const booleans = meaningful.filter((m) => m.isBooleanLiteralType())
  if (booleans.length === 2 && meaningful.length === 2) {
    return nullable ? { type: ['boolean', 'null'] } : { type: 'boolean' }
  }

  if (meaningful.length === 1) {
    const only = typeToSchema(context, meaningful[0], location)
    return nullable ? withNull(only) : only
  }

  const literals = meaningful.filter((m) => m.isStringLiteralType() || m.isNumberLiteralType())
  if (literals.length === meaningful.length) {
    const strings = literals.every((m) => m.isStringLiteralType())
    const numbers = literals.every((m) => m.isNumberLiteralType())
    if (strings || numbers) {
      const base: SchemaType = strings ? 'string' : 'number'
      // Sorted here as well as in the writer, so the guarantee is ours rather than the compiler's.
      const enumMembers = strings ? sorted(stringValues(literals), compareCodePoints) : sorted(numberValues(literals), (a, b) => a - b)
      const schema: Schema = {
        type: nullable ? [base, 'null'] : base,
        enum: enumMembers,
      }
      return schema
    }
  }

  const branches = meaningful.map((m) => typeToSchema(context, m, location))
  return { oneOf: nullable ? [...branches, { type: 'null' }] : branches }
}

/**
 * Literal values, read through the declared narrowings rather than asserted.
 */
function stringValues(types: readonly Type[]): string[] {
  return types.flatMap((type) => (type.isStringLiteralType() ? [type.value] : []))
}

function numberValues(types: readonly Type[]): number[] {
  return types.flatMap((type) => (type.isNumberLiteralType() ? [type.value] : []))
}

function withNull(schema: Schema): Schema {
  if (typeof schema.type === 'string') return { ...schema, type: [schema.type, 'null'] }
  if (Array.isArray(schema.type)) return { ...schema, type: [...schema.type, 'null'] }
  return { oneOf: [schema, { type: 'null' }] }
}

function objectSchema(context: WalkContext, type: Type, location: string): Schema {
  const properties: Record<string, Schema> = {}
  const required: string[] = []

  for (const symbol of context.checker.getPropertiesOfType(type)) {
    const propertyType = typeOfSymbol(context, symbol)
    const schema = typeToSchema(context, propertyType, location)
    const doc = readDoc(context.checker, symbol)
    properties[symbol.name] = doc.description || Object.keys(doc.tags).length > 0 ? applyTags(schema, doc) : schema
    if (!isOptional(symbol)) required.push(symbol.name)
  }

  const indexInfos = context.checker.getIndexInfosOfType(type)
  const stringIndex = indexInfos.find((info) => {
    const key = info.keyType
    return key.isIntrinsicType() && key.intrinsicName === 'string'
  })

  const schema: Schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  schema.additionalProperties = stringIndex ? typeToSchema(context, stringIndex.valueType, location) : false
  if (Object.keys(properties).length === 0 && stringIndex) delete schema.properties
  return schema
}

/**
 * Applies the JSDoc tag vocabulary to a property schema.
 */
export function applyTags(schema: Schema, doc: { description?: string; tags: Record<string, string[]> }): Schema {
  const out: Schema = { ...schema }
  if (doc.description) out.description = doc.description

  const first = (name: string): string | undefined => doc.tags[name]?.[0]
  const num = (name: string): number | undefined => {
    const raw = first(name)
    if (raw === undefined) return undefined
    const value = Number(raw)
    return Number.isFinite(value) ? value : undefined
  }

  const format = first('format')
  if (format) out.format = format
  const pattern = first('pattern')
  if (pattern) out.pattern = pattern
  const title = first('title')
  if (title) out.title = title

  const constraints: Partial<Record<string, number>> = {}
  for (const [tag, key] of [
    ['minLength', 'minLength'],
    ['maxLength', 'maxLength'],
    ['minimum', 'minimum'],
    ['maximum', 'maximum'],
    ['exclusiveMinimum', 'exclusiveMinimum'],
    ['exclusiveMaximum', 'exclusiveMaximum'],
    ['multipleOf', 'multipleOf'],
    ['minItems', 'minItems'],
    ['maxItems', 'maxItems'],
    ['minProperties', 'minProperties'],
    ['maxProperties', 'maxProperties'],
  ] as const) {
    const value = num(tag)
    if (value !== undefined) constraints[key] = value
  }
  Object.assign(out, constraints)

  if (doc.tags.uniqueItems) out.uniqueItems = true
  if (doc.tags.deprecated) out.deprecated = true
  if (doc.tags.readOnly) out.readOnly = true
  if (doc.tags.writeOnly) out.writeOnly = true

  const parseJson = (raw: string | undefined): Json | undefined => {
    if (raw === undefined) return undefined
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }

  const example = parseJson(first('example'))
  if (example !== undefined) out.example = example
  const fallback = parseJson(first('default'))
  if (fallback !== undefined) out.default = fallback

  return out
}
