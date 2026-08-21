/**
 * Reading JSON bodies in tests without asserting a shape the server might not have produced.
 *
 * `Response.json()` is typed `unknown`, and casting it would mean a test claiming a shape rather
 * than checking one. These helpers narrow with real predicates, so a wrong body fails the test at
 * the point it is read instead of somewhere further along.
 */

/**
 * True for a JSON object, as opposed to an array or a primitive.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads a JSON object body. Every property access on the result stays `unknown`, and so checked.
 */
export async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json()
  if (!isRecord(body)) throw new Error(`expected a JSON object body, got ${Array.isArray(body) ? 'an array' : typeof body}`)
  return body
}

/**
 * Reads a nested object, failing with the path that was missing rather than a type error.
 */
export function child(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key]
  if (!isRecord(value)) throw new Error(`expected ${key} to be an object`)
  return value
}

/**
 * Reads an array of JSON objects, for things like a validation `problems` list.
 */
export function records(body: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = body[key]
  if (!Array.isArray(value)) throw new Error(`expected ${key} to be an array`)
  return value.filter(isRecord)
}
