/**
 * Reading the JSDoc vocabulary that carries everything TypeScript cannot express.
 * See docs/CONTRIBUTING/TYPE_MAPPING.md#jsdoc-tags.
 */

import type { Checker, Symbol as TsSymbol } from 'typescript/unstable/sync'

export interface Doc {
  /**
   * First line of the comment. Becomes `summary` on an operation, `description` on a schema.
   */
  summary?: string
  /**
   * Prose after the first blank line. Becomes `description` on an operation.
   */
  body?: string
  /**
   * The whole comment, for places that want one string.
   */
  description?: string
  /**
   * Tags by name. Repeated tags keep every occurrence, in source order.
   */
  tags: Record<string, string[]>
}

/**
 * Reads the documentation comment and tags attached to a symbol.
 */
export function readDoc(checker: Checker, symbol: TsSymbol | undefined): Doc {
  if (!symbol) return { tags: {} }

  const comment = symbol.getDocumentationComment(checker).trim()
  const tags: Record<string, string[]> = {}

  for (const tag of symbol.getJsDocTags(checker)) {
    const list = tags[tag.name] ?? []
    list.push((tag.text ?? '').trim())
    tags[tag.name] = list
  }

  if (comment === '') return { tags }

  // The first line is the summary; prose after a blank line is the longer description.
  const newline = comment.indexOf('\n')
  const summary = (newline === -1 ? comment : comment.slice(0, newline)).trim()
  const rest = newline === -1 ? '' : comment.slice(newline + 1)
  const blank = rest.search(/\n\s*\n/)
  const body = (blank === -1 ? rest : rest.slice(blank)).trim()

  return {
    summary,
    body: body || undefined,
    description: comment,
    tags,
  }
}

/**
 * Splits a space-separated tag value, as `@tags users admin` uses.
 */
export function words(value: string | undefined): string[] {
  if (!value) return []
  return value.split(/\s+/).filter((w) => w.length > 0)
}
