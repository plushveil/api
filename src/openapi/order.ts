/**
 * The canonical emission order from docs/CONTRIBUTING/TYPE_MAPPING.md#ordering.
 *
 * Output must depend only on content — never on declaration order, filesystem order, or map
 * iteration order — so that `openapi.json` is diffable and `api-port --check` is meaningful.
 */

import { METHODS } from './types.ts'

/**
 * Compares by Unicode code point. `localeCompare` is deliberately avoided: it is
 * locale-sensitive, so it would make output depend on the machine that produced it.
 */
export function compareCodePoints(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * Sorts a copy. Never sort a caller's array in place — the document model is shared.
 */
export function sorted<T>(values: Iterable<T>, compare: (a: T, b: T) => number): T[] {
  return [...values].sort(compare)
}

/**
 * Keyword order within a schema object. Fixed template, not alphabetical.
 */
export const SCHEMA_KEYS = ['$ref', 'type', 'format', 'description', 'enum', 'const', 'default', 'example', 'items', 'prefixItems', 'properties', 'required', 'additionalProperties', 'oneOf', 'allOf', 'anyOf']

export const DOCUMENT_KEYS = ['openapi', 'info', 'servers', 'paths', 'components']
export const INFO_KEYS = ['title', 'version', 'description']
export const OPERATION_KEYS = ['operationId', 'summary', 'description', 'tags', 'deprecated', 'security', 'parameters', 'requestBody', 'responses']
export const PARAMETER_KEYS = ['name', 'in', 'required', 'deprecated', 'description', 'style', 'explode', 'schema']
export const REQUEST_BODY_KEYS = ['description', 'required', 'content']
export const RESPONSE_KEYS = ['description', 'content']
export const COMPONENTS_KEYS = ['schemas', 'securitySchemes']
export const SERVER_KEYS = ['url', 'description']

/**
 * Orders keys by a fixed template, with anything not in the template sorted after it. Unknown
 * keys are kept rather than dropped, so a document round-trips even when it carries keywords
 * this build does not model.
 */
export function byTemplate(template: string[]): (a: string, b: string) => number {
  return (a, b) => {
    const ia = template.indexOf(a)
    const ib = template.indexOf(b)
    if (ia !== -1 && ib !== -1) return ia - ib
    if (ia !== -1) return -1
    if (ib !== -1) return 1
    return compareCodePoints(a, b)
  }
}

const LOCATION_RANK: Record<string, number> = { path: 0, query: 1, header: 2, cookie: 3 }

/**
 * Parameters sort by location, then by name.
 */
export function compareParameters(a: { name: string; in: string }, b: { name: string; in: string }): number {
  const ra = LOCATION_RANK[a.in] ?? 9
  const rb = LOCATION_RANK[b.in] ?? 9
  return ra !== rb ? ra - rb : compareCodePoints(a.name, b.name)
}

/**
 * Response keys sort numerically ascending, with `default` last.
 */
export function compareStatuses(a: string, b: string): number {
  if (a === 'default') return b === 'default' ? 0 : 1
  if (b === 'default') return -1
  const na = Number(a)
  const nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  return compareCodePoints(a, b)
}

/**
 * Methods within a path item use a fixed order rather than an alphabetical one.
 */
export function compareMethods(a: string, b: string): number {
  const ia = (METHODS as readonly string[]).indexOf(a)
  const ib = (METHODS as readonly string[]).indexOf(b)
  if (ia !== -1 && ib !== -1) return ia - ib
  if (ia !== -1) return -1
  if (ib !== -1) return 1
  return compareCodePoints(a, b)
}

/**
 * `enum` members sort by value: strings by code point, numbers numerically. Mixed-type enums
 * fall back to comparing the JSON encoding, which is stable if not especially meaningful.
 */
export function compareEnumMembers(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'string' && typeof b === 'string') return compareCodePoints(a, b)
  return compareCodePoints(JSON.stringify(a) ?? '', JSON.stringify(b) ?? '')
}
