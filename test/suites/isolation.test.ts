/**
 * The dependency rules from docs/CONTRIBUTING/ARCHITECTURE.md, enforced rather than trusted.
 */

import * as assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'

const root = new URL('../../', import.meta.url).pathname

/**
 * Node builtins the runtime packages may use.
 */
const ALLOWED_BUILTINS = new Set(['node:http', 'node:fs', 'node:fs/promises', 'node:path', 'node:url', 'node:net', 'node:stream', 'node:stream/promises', 'node:util'])

/**
 * Follows relative imports from an entry point and returns every specifier seen.
 */
async function closure(entry: string): Promise<{ files: string[]; specifiers: Set<string> }> {
  const seen = new Set<string>()
  const specifiers = new Set<string>()
  const queue = [resolve(root, entry)]

  while (queue.length > 0) {
    const file = queue.pop()
    if (file === undefined) break
    if (seen.has(file)) continue
    seen.add(file)

    const text = await readFile(file, 'utf8')
    for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*from\s*['"](?<specifier>[^'"]+)['"]/g)) {
      const specifier = match.groups?.specifier ?? ''
      specifiers.add(specifier)
      if (!specifier.startsWith('.')) continue
      queue.push(resolve(dirname(file), specifier))
    }
  }

  return { files: [...seen], specifiers }
}

await describe('package isolation', async () => {
  for (const entry of ['src/server/main.ts', 'src/client/main.ts']) {
    await it(`${entry} never reaches typescript`, async () => {
      const { specifiers, files } = await closure(entry)
      // The bare name is not enough: the only import that matters is `typescript/unstable/sync`.
      const offenders = [...specifiers].filter((s) => s === 'typescript' || s.startsWith('typescript/'))
      assert.deepEqual(offenders, [], `${entry} reaches ${offenders.join(', ')}`)
      assert.ok(files.length > 1, 'expected the closure walk to find more than the entry point')
    })

    await it(`${entry} uses no third-party runtime dependency`, async () => {
      const { specifiers } = await closure(entry)
      const bare = [...specifiers].filter((s) => !s.startsWith('.'))
      const unexpected = bare.filter((s) => !ALLOWED_BUILTINS.has(s))
      assert.deepEqual(unexpected, [], `unexpected bare specifiers: ${unexpected.join(', ')}`)
    })
  }

  await it('src/client reaches no node builtin at all', async () => {
    // The client must run in a browser, so even a builtin would be a defect.
    const { specifiers } = await closure('src/client/main.ts')
    const builtins = [...specifiers].filter((s) => s.startsWith('node:'))
    assert.deepEqual(builtins, [])
  })

  await it('src/schema stays free of I/O so both sides can share it', async () => {
    const { specifiers } = await closure('src/schema/main.ts')
    const bare = [...specifiers].filter((s) => !s.startsWith('.'))
    assert.deepEqual(bare, [])
  })

  await it('node:http appears only in the server adapter', async () => {
    const { files } = await closure('src/server/main.ts')
    const importers: string[] = []
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      if (/from 'node:http'/.test(text)) importers.push(file.slice(root.length))
    }
    // `createServer` itself needs it too; the point is that it does not leak into the core.
    assert.deepEqual(importers.sort(), ['src/server/adapters/node.ts', 'src/server/server.ts'])
  })
})
