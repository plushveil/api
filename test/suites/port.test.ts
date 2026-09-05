/**
 * The round trip, driven through the real binaries rather than the library.
 *
 * `port(backport(spec)) === spec` is the project's central promise, and it can only be checked by
 * actually type-checking a generated folder — which needs a workspace where `@plushveil/api`
 * resolves. Each test builds one in a temp directory.
 */

import * as assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { isRecord } from '../helpers/json.ts'

const root = new URL('../../', import.meta.url).pathname
const FIXTURE = join(root, 'test/fixtures/api-health')
const PORT = join(root, 'bin/port.ts')
const BACKPORT = join(root, 'bin/backport.ts')

const spec: unknown = JSON.parse(await readFile(join(FIXTURE, 'openapi.json'), 'utf8'))
if (!isRecord(spec) || !isRecord(spec.info) || typeof spec.info.version !== 'string') throw new Error('expected the fixture to have info.version')
const FIXTURE_VERSION = spec.info.version

interface Run {
  code: number
  stdout: string
  stderr: string
}

function run(script: string, args: string[], options: { cwd?: string } = {}): Promise<Run> {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: options.cwd ?? root })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', fail)
    child.on('close', (code) => settle({ code: code ?? -1, stdout, stderr }))
  })
}

/**
 * Runs one of the repo's own dev tools from `node_modules`, so no PATH lookup is involved.
 */
function tool(name: string, args: string[]): Promise<Run> {
  return new Promise((settle, fail) => {
    const child = spawn(join(root, 'node_modules', name, 'bin', name), args, { cwd: root })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', fail)
    child.on('close', (code) => settle({ code: code ?? -1, stdout, stderr }))
  })
}

/**
 * A workspace where a generated `api/` folder can be type-checked: the emitted modules import
 * `@plushveil/api/server`, so the package has to be resolvable from it.
 */
async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'api-roundtrip-'))
  await mkdir(join(dir, 'node_modules/@plushveil'), { recursive: true })
  await mkdir(join(dir, 'node_modules/@types'), { recursive: true })
  await symlink(root, join(dir, 'node_modules/@plushveil/api'), 'dir')
  await symlink(join(root, 'node_modules/typescript'), join(dir, 'node_modules/typescript'), 'dir')
  await symlink(join(root, 'node_modules/@types/node'), join(dir, 'node_modules/@types/node'), 'dir')
  await copyFile(join(root, 'tsconfig.json'), join(dir, 'tsconfig.json'))
  await writeFile(join(dir, 'package.json'), `${JSON.stringify({ name: 'roundtrip-probe', version: '1.0.0', type: 'module' }, null, 2)}\n`, 'utf8')
  return dir
}

await describe('api-port', async () => {
  await it('reproduces the committed specification from the fixture', async () => {
    const dir = await workspace()
    const out = join(dir, 'openapi.json')
    const types = join(dir, 'api.types.ts')

    const result = await run(PORT, [join(FIXTURE, 'api'), '--out', out, '--types', types, '--title', '@plushveil/api', '--api-version', FIXTURE_VERSION])
    assert.equal(result.code, 0, result.stderr)

    assert.equal(await readFile(out, 'utf8'), await readFile(join(FIXTURE, 'openapi.json'), 'utf8'))
    assert.equal(await readFile(types, 'utf8'), await readFile(join(FIXTURE, 'api.types.ts'), 'utf8'))
  })

  await it('writes the specification to stdout for `--out -`', async () => {
    const result = await run(PORT, [join(FIXTURE, 'api'), '--out', '-', '--no-types', '--api-version', FIXTURE_VERSION])
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stdout, await readFile(join(FIXTURE, 'openapi.json'), 'utf8'))
  })

  await it('refuses a route module that does not typecheck instead of emitting a wrong spec', async () => {
    const dir = await workspace()
    await mkdir(join(dir, 'api/broken'), { recursive: true })
    await writeFile(
      join(dir, 'api/broken/get.ts'),
      ['export interface Operation {', '  responses: {', '    200: ThisTypeDoesNotExist', '  }', '}', 'export const handler = async () => ({ status: 200 as const, body: null })', ''].join('\n'),
      'utf8',
    )

    const result = await run(PORT, ['./api', '--out', join(dir, 'openapi.json'), '--no-types'], { cwd: dir })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /does not typecheck/)
  })

  await it('does not treat one shared schema type imported into two route files as a naming collision', async () => {
    const dir = await workspace()
    await mkdir(join(dir, 'api/one'), { recursive: true })
    await mkdir(join(dir, 'api/two'), { recursive: true })
    await writeFile(join(dir, 'api/schemas.ts'), ['export interface Shared {', '  id: string', '}', ''].join('\n'), 'utf8')
    for (const name of ['one', 'two']) {
      await writeFile(
        join(dir, `api/${name}/get.ts`),
        [
          `import type { Shared } from '../schemas.ts'`,
          'export interface Operation {',
          '  responses: {',
          '    200: Shared',
          '  }',
          '}',
          "export const handler = async () => ({ status: 200 as const, body: { id: 'x' } })",
          '',
        ].join('\n'),
        'utf8',
      )
    }

    const result = await run(PORT, ['./api', '--out', join(dir, 'openapi.json'), '--no-types'], { cwd: dir })
    assert.equal(result.code, 0, result.stderr)
  })

  await it('still rejects two different route-local types that happen to share a name', async () => {
    const dir = await workspace()
    await mkdir(join(dir, 'api/one'), { recursive: true })
    await mkdir(join(dir, 'api/two'), { recursive: true })
    await writeFile(
      join(dir, 'api/one/get.ts'),
      ['interface Dup {', '  a: string', '}', 'export interface Operation {', '  responses: {', '    200: Dup', '  }', '}', "export const handler = async () => ({ status: 200 as const, body: { a: 'x' } })", ''].join(
        '\n',
      ),
      'utf8',
    )
    await writeFile(
      join(dir, 'api/two/get.ts'),
      ['interface Dup {', '  b: string', '}', 'export interface Operation {', '  responses: {', '    200: Dup', '  }', '}', "export const handler = async () => ({ status: 200 as const, body: { b: 'x' } })", ''].join(
        '\n',
      ),
      'utf8',
    )

    const result = await run(PORT, ['./api', '--out', join(dir, 'openapi.json'), '--no-types'], { cwd: dir })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /both named "Dup"/)
  })
})

await describe('api-backport', async () => {
  await it('produces a folder whose port reproduces the original specification', async () => {
    const dir = await workspace()
    const original = await readFile(join(FIXTURE, 'openapi.json'), 'utf8')
    await writeFile(join(dir, 'original.json'), original, 'utf8')

    const back = await run(BACKPORT, [join(dir, 'original.json'), '--out', join(dir, 'api'), '--types', join(dir, 'api.types.ts')])
    assert.equal(back.code, 0, back.stderr)

    // The whole point: round-tripping through generated code changes nothing.
    const again = await run(PORT, ['./api', '--out', './reported.json', '--no-types', '--title', '@plushveil/api', '--api-version', FIXTURE_VERSION], { cwd: dir })
    assert.equal(again.code, 0, again.stderr)
    assert.equal(await readFile(join(dir, 'reported.json'), 'utf8'), original)
  })

  await it("emits generated files that satisfy this project's format and lint rules", async () => {
    const dir = await workspace()
    const back = await run(BACKPORT, [join(FIXTURE, 'openapi.json'), '--out', join(dir, 'api'), '--types', join(dir, 'api.types.ts')])
    assert.equal(back.code, 0, back.stderr)

    // Generated output must already be formatted, or `npm test` would fail on our own emission.
    const check = await tool('oxfmt', ['--check', join(dir, 'api'), join(dir, 'api.types.ts')])
    assert.equal(check.code, 0, `${check.stdout}\n${check.stderr}`)

    const lint = await tool('oxlint', [join(dir, 'api'), join(dir, 'api.types.ts')])
    assert.equal(lint.code, 0, `${lint.stdout}\n${lint.stderr}`)
  })

  await it('rewrites api/schemas.ts without --force, unlike a route module', async () => {
    const dir = await workspace()
    const args = [join(FIXTURE, 'openapi.json'), '--out', join(dir, 'api'), '--types', join(dir, 'api.types.ts')]

    assert.equal((await run(BACKPORT, args)).code, 0)
    await writeFile(join(dir, 'api/schemas.ts'), '// clobbered\n', 'utf8')

    // schemas.ts is a generated artefact, so it comes back even though the route file is protected.
    const second = await run(BACKPORT, args)
    assert.equal(second.code, 4)
    assert.match(await readFile(join(dir, 'api/schemas.ts'), 'utf8'), /export interface HealthStatus/)
  })
})

const BINARY_FIXTURE = join(root, 'test/fixtures/api-binary')

/**
 * `Content<M, T>` -- binary and streaming media types -- round-tripped through the real CLIs, the
 * same promise `describe('api-backport')` above checks for JSON-only operations. Regenerate this
 * fixture's `openapi.json`/`api.types.ts` with:
 *
 * ```bash
 * node bin/port.ts test/fixtures/api-binary/api --out test/fixtures/api-binary/openapi.json \
 *   --types test/fixtures/api-binary/api.types.ts --title '@plushveil/api' --api-version 0.0.1
 * ```
 */
await describe('api-port and api-backport, for Content<M, T>', async () => {
  await it('extracts a declared media type, a streaming flag, and a Content union from real source', async () => {
    const dir = await workspace()
    const out = join(dir, 'openapi.json')

    const result = await run(PORT, [join(BINARY_FIXTURE, 'api'), '--out', out, '--no-types', '--title', '@plushveil/api', '--api-version', '0.0.1'])
    assert.equal(result.code, 0, result.stderr)
    assert.equal(await readFile(out, 'utf8'), await readFile(join(BINARY_FIXTURE, 'openapi.json'), 'utf8'))
  })

  await it('emits Content<M, T> and ReadableStream<Uint8Array> from the committed specification', async () => {
    const dir = await workspace()
    const types = join(dir, 'api.types.ts')

    const result = await run(PORT, [join(BINARY_FIXTURE, 'api'), '--out', join(dir, 'openapi.json'), '--types', types, '--title', '@plushveil/api', '--api-version', '0.0.1'])
    assert.equal(result.code, 0, result.stderr)
    assert.equal(await readFile(types, 'utf8'), await readFile(join(BINARY_FIXTURE, 'api.types.ts'), 'utf8'))
  })

  await it('round-trips through generated route modules without changing the specification', async () => {
    const dir = await workspace()
    const original = await readFile(join(BINARY_FIXTURE, 'openapi.json'), 'utf8')

    const back = await run(BACKPORT, [join(BINARY_FIXTURE, 'openapi.json'), '--out', join(dir, 'api'), '--types', join(dir, 'api.types.ts')])
    assert.equal(back.code, 0, back.stderr)

    // The generated route modules live outside this repo's own tsconfig `include`, so the project
    // has to be pointed at the workspace explicitly here -- unlike the JSON-only round trip above,
    // whose fixture sits inside this repo and resolves against its default project.
    const again = await run(PORT, ['./api', '--out', './reported.json', '--no-types', '--title', '@plushveil/api', '--api-version', '0.0.1', '--project', './tsconfig.json'], { cwd: dir })
    assert.equal(again.code, 0, again.stderr)
    assert.equal(await readFile(join(dir, 'reported.json'), 'utf8'), original)
  })
})
