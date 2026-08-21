/**
 * Route patterns and the specificity ordering that makes `/users/me` win over
 * `/users/{userId}` regardless of registration order.
 */

import type { Route, Segment } from './types.ts'

/**
 * Splits a pathname into segments, dropping the empty ones so `/a//b` matches `/a/b`.
 */
export function splitPath(pathname: string): string[] {
  return pathname.split('/').filter((s) => s.length > 0)
}

/**
 * Parses a pattern into segments. `{name}` is a single-segment parameter and `{...name}` is a
 * catch-all matching one or more segments.
 */
export function parsePattern(pattern: string): Segment[] {
  return splitPath(pattern).map((raw) => {
    if (raw.startsWith('{') && raw.endsWith('}')) {
      const inner = raw.slice(1, -1)
      if (inner.startsWith('...')) return { kind: 'catchAll', name: inner.slice(3) }
      return { kind: 'param', name: inner }
    }
    return { kind: 'static', value: raw }
  })
}

/**
 * Turns a matcher pattern into the spec-facing path: `/files/{...rest}` → `/files/{rest}`.
 */
export function patternToPath(pattern: string): string {
  const path = splitPath(pattern)
    .map((raw) => (raw.startsWith('{...') && raw.endsWith('}') ? `{${raw.slice(4, -1)}}` : raw))
    .join('/')
  return `/${path}`
}

const RANK = { static: 0, param: 1, catchAll: 2 } as const

/**
 * Orders routes most specific first. Depends only on the pattern, never on when a route was
 * registered, so the same set of routes always resolves the same way.
 *
 * There is no separate "catch-all last" clause: where two patterns share a rank prefix, the
 * segment-count comparison already places the catch-all last. Brute-forcing every route shape up
 * to three segments confirms adding one changes no pair.
 */
export function compareRoutes(a: Route, b: Route): number {
  const shared = Math.min(a.segments.length, b.segments.length)
  for (let i = 0; i < shared; i++) {
    const ra = RANK[a.segments[i].kind]
    const rb = RANK[b.segments[i].kind]
    if (ra !== rb) return ra - rb
  }
  if (a.segments.length !== b.segments.length) return a.segments.length - b.segments.length
  if (a.pattern !== b.pattern) return a.pattern < b.pattern ? -1 : 1
  if (a.method === b.method) return 0
  return a.method < b.method ? -1 : 1
}

/**
 * Matches segments against a pattern, returning the captured parameters.
 *
 * Captures are percent-decoded: `URL.pathname` does not decode, so without this a client that
 * encoded a parameter and a server that read it would disagree. A malformed escape is reported as
 * a bad parameter rather than crashing.
 */
export function matchSegments(segments: Segment[], parts: string[]): Record<string, string> | undefined {
  const captured: Record<string, string> = {}

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]

    if (segment.kind === 'catchAll') {
      // A catch-all must consume at least one segment, and always the rest.
      if (i !== segments.length - 1 || parts.length < i + 1) return undefined
      captured[segment.name] = parts.slice(i).map(decodeSegment).join('/')
      return captured
    }

    const part = parts[i]
    if (part === undefined) return undefined
    if (segment.kind === 'static') {
      if (part !== segment.value) return undefined
      continue
    }
    captured[segment.name] = decodeSegment(part)
  }

  return parts.length === segments.length ? captured : undefined
}

/**
 * Raised for a path segment whose percent-encoding is malformed.
 */
export class MalformedPathError extends Error {
  readonly segment: string

  constructor(segment: string) {
    super(`The path segment ${JSON.stringify(segment)} is not valid percent-encoding`)
    this.name = 'MalformedPathError'
    this.segment = segment
  }
}

function decodeSegment(part: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    throw new MalformedPathError(part)
  }
}
