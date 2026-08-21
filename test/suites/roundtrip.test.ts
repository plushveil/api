/**
 * The round trip is the project's core promise, so these are the assertions that make it
 * falsifiable. See docs/CONTRIBUTING/ARCHITECTURE.md.
 */

import * as assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { parseDocument, stringify } from '../../src/openapi/main.ts'
import { emitAll, emitApiTypes, emitSchemas, routeFileFor } from '../../src/typescript/main.ts'

const root = new URL('../fixtures/api-health/', import.meta.url)

async function committedSpec(): Promise<string> {
  return readFile(new URL('openapi.json', root), 'utf8')
}

await describe('round trip', async () => {
  await it('emits api.types.ts identical to the committed file', async () => {
    // The same document produces the same types whichever direction it arrived from.
    const document = parseDocument(await committedSpec())
    const expected = await readFile(new URL('api.types.ts', root), 'utf8')
    assert.equal(emitApiTypes(document), expected)
  })

  await it('emits api/schemas.ts deterministically', async () => {
    const document = parseDocument(await committedSpec())
    assert.equal(emitSchemas(document), emitSchemas(document))
    assert.match(emitSchemas(document), /export interface HealthStatus \{/)
  })

  await it('emits every file identically across runs', async () => {
    const document = parseDocument(await committedSpec())
    assert.deepEqual(emitAll(document), emitAll(document))
  })

  await it('does not mutate the document it emits from', async () => {
    const bytes = await committedSpec()
    const document = parseDocument(bytes)
    emitAll(document)
    emitApiTypes(document)
    assert.equal(stringify(document), bytes)
  })

  await it('maps a path and method onto the documented file name', async () => {
    assert.equal(routeFileFor('/health', 'get'), 'health/get.ts')
    assert.equal(routeFileFor('/users/{userId}', 'get'), 'users/[userId]/get.ts')
    assert.equal(routeFileFor('/', 'get'), 'get.ts')
  })

  await it('emits a route module that reaches schemas.ts at the right depth', async () => {
    const document = parseDocument(await committedSpec())
    const route = emitAll(document).find((f) => f.path === 'health/get.ts')
    assert.ok(route, 'expected a route file for get /health')
    // From api/health/get.ts, one `../` reaches api/, where schemas.ts lives.
    assert.match(route.text, /from '\.\.\/schemas\.ts'/)
    assert.match(route.text, /from '@plushveil\/api\/server'/)
  })

  await it('emits no `body` key when the operation has no request body', async () => {
    // An absent key is what distinguishes "no body" from "a body typed never": `Op['body']` on a
    // missing key resolves to `unknown`, so emitting `never` would break the client's arity rule.
    const document = parseDocument(await committedSpec())
    const route = emitAll(document).find((f) => f.path === 'health/get.ts')
    assert.ok(route)
    assert.equal(route.text.includes('body'), false)
  })

  await it('does not write back a description that is only the standard reason phrase', async () => {
    // Otherwise every pass through the round trip would accrete an @description tag.
    const document = parseDocument(await committedSpec())
    const route = emitAll(document).find((f) => f.path === 'health/get.ts')
    assert.ok(route)
    assert.equal(route.text.includes('@description OK'), false)
  })
})
