/**
 * The textual diff `api-port --check` prints.
 *
 * The verdict is always bytes: two artefacts are the same or they are not. This produces the
 * human-readable explanation of a difference, not the decision itself.
 *
 * Deliberately not an LCS diff. Trimming the common prefix and suffix and printing one hunk is
 * enough to point a reader at a regenerated file, and it cannot go quadratic on a large document.
 */

export interface DiffOptions {
  /**
   * Label for the on-disk side.
   */
  from?: string
  /**
   * Label for the generated side.
   */
  to?: string
  /**
   * Lines of unchanged context to keep around the hunk.
   */
  context?: number
  /**
   * Maximum lines to print before truncating.
   */
  limit?: number
}

/**
 * Returns an empty string when the two texts are identical.
 */
export function diff(disk: string, generated: string, options: DiffOptions = {}): string {
  if (disk === generated) return ''

  const from = options.from ?? 'disk'
  const to = options.to ?? 'generated'
  const context = options.context ?? 3
  const limit = options.limit ?? 120

  const a = disk.split('\n')
  const b = generated.split('\n')

  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++

  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const head = Math.max(0, start - context)
  const tailA = Math.min(a.length, endA + context)
  const tailB = Math.min(b.length, endB + context)

  const lines: string[] = [`--- ${from}`, `+++ ${to}`, `@@ -${head + 1},${tailA - head} +${head + 1},${tailB - head} @@`]

  for (let i = head; i < start; i++) lines.push(` ${a[i]}`)
  for (let i = start; i < endA; i++) lines.push(`-${a[i]}`)
  for (let i = start; i < endB; i++) lines.push(`+${b[i]}`)
  for (let i = endA; i < tailA; i++) lines.push(` ${a[i]}`)

  if (lines.length > limit) {
    const dropped = lines.length - limit
    return `${lines.slice(0, limit).join('\n')}\n… ${dropped} more line${dropped === 1 ? '' : 's'}`
  }
  return lines.join('\n')
}
