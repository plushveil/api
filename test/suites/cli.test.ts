/**
 * The CLI contract from docs/CONTRIBUTING/CLI.md, exercised through the real binaries.
 *
 * Spawning is the only way to cover the shebang, the `bin` mapping, and `process.exitCode`
 * propagation, so these tests pay for a child process each.
 */

import * as assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { isRecord } from '../helpers/json.ts'

const root = new URL('../../', import.meta.url).pathname
const FIXTURE = join(root, 'test/fixtures/api-health')
const PORT = join(root, 'bin/port.ts')
const BACKPORT = join(root, 'bin/backport.ts')

const fixtureSpec: unknown = JSON.parse(await readFile(join(FIXTURE, 'openapi.json'), 'utf8'))
if (!isRecord(fixtureSpec) || !isRecord(fixtureSpec.info) || typeof fixtureSpec.info.version !== 'string') throw new Error('expected the fixture to have info.version')
const FIXTURE_VERSION = fixtureSpec.info.version

/**
 * The fixture's own artefacts, which `--check` is expected to agree with. `--api-version` is
 * pinned to the fixture's own version rather than left to default to the package's, so the
 * fixture does not need regenerating every time the package version changes.
 */
const ARTEFACTS = ['--out', join(FIXTURE, 'openapi.json'), '--types', join(FIXTURE, 'api.types.ts'), '--api-version', FIXTURE_VERSION]

interface Run {
  code: number
  stdout: string
  stderr: string
}

function run(script: string, args: string[], cwd = root): Promise<Run> {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, [script, ...args], { cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', fail)
    child.on('close', (code) => settle({ code: code ?? -1, stdout, stderr }))
  })
}

await describe('api-port', async () => {
  await it('prints its version and exits 0', async () => {
    const result = await run(PORT, ['--version'])
    assert.equal(result.code, 0)
    assert.match(result.stdout.trim(), /^@plushveil\/api \d+\.\d+\.\d+$/)
  })

  await it('prints help listing every documented flag', async () => {
    const result = await run(PORT, ['--help'])
    assert.equal(result.code, 0)
    for (const flag of ['--out', '--types', '--no-types', '--format', '--title', '--api-version', '--description', '--server', '--base-path', '--project', '--check', '--watch', '--silent', '--config']) {
      assert.ok(result.stdout.includes(flag), `--help is missing ${flag}`)
    }
  })

  await it('exits 2 for an unknown option', async () => {
    const result = await run(PORT, ['--bogus'])
    assert.equal(result.code, 2)
    assert.match(result.stderr, /Usage:/)
  })

  await it('exits 2 for an invalid enum value', async () => {
    const result = await run(PORT, ['--format', 'xml'])
    assert.equal(result.code, 2)
    assert.match(result.stderr, /expected json\|yaml/)
  })

  await it('exits 2 for contradictory flags', async () => {
    const result = await run(PORT, ['--types', 'x.ts', '--no-types'])
    assert.equal(result.code, 2)
  })

  await it('exits 1, not 2, for a documented but unimplemented flag', async () => {
    // Reporting a documented flag as unknown would be an exit-2 lie.
    const result = await run(PORT, ['--format', 'yaml'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /not implemented/)
  })

  await it('exits 0 from --check against the committed artefacts, with default flags', async () => {
    const result = await run(PORT, [join(FIXTURE, 'api'), ...ARTEFACTS, '--check'])
    assert.equal(result.code, 0, result.stderr)
  })

  await it('exits 3 and writes nothing when the artefacts have drifted', async () => {
    // The tampered copy lives in a temp directory rather than in the fixture: `node --test` runs
    // suites in parallel, and three other files read the committed artefacts while this one runs.
    const workspace = await mkdtemp(join(tmpdir(), 'api-drift-'))
    const spec = join(workspace, 'openapi.json')
    const types = join(workspace, 'api.types.ts')

    const original = await readFile(join(FIXTURE, 'openapi.json'), 'utf8')
    const tampered = original.replace('"openapi": "3.1.0"', '"openapi": "3.1.1"')
    assert.notEqual(tampered, original, 'expected the tamper to change something')

    await writeFile(spec, tampered, 'utf8')
    await copyFile(join(FIXTURE, 'api.types.ts'), types)

    const result = await run(PORT, [join(FIXTURE, 'api'), '--out', spec, '--types', types, '--check'])
    assert.equal(result.code, 3)
    assert.match(result.stderr, /^--- /m)
    assert.equal(await readFile(spec, 'utf8'), tampered, '--check must not write')
  })
})

await describe('api-backport', async () => {
  await it('exits 2 when the required positional is missing', async () => {
    const result = await run(BACKPORT, [])
    assert.equal(result.code, 2)
  })

  await it('writes the folder, then refuses to overwrite without --force', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'api-backport-'))
    const spec = join(FIXTURE, 'openapi.json')

    const first = await run(BACKPORT, [spec, '--out', join(workspace, 'api'), '--types', join(workspace, 'api.types.ts')])
    assert.equal(first.code, 0, first.stderr)

    const route = join(workspace, 'api/health/get.ts')
    const generated = await readFile(route, 'utf8')

    // Mark the file, then confirm a second run leaves it alone and still exits 4.
    await writeFile(route, `${generated}\n// hand-edited\n`, 'utf8')
    const second = await run(BACKPORT, [spec, '--out', join(workspace, 'api'), '--types', join(workspace, 'api.types.ts')])
    assert.equal(second.code, 4)
    assert.match(await readFile(route, 'utf8'), /hand-edited/)

    // With --force it is rewritten, and the result is byte-identical to the first run.
    const third = await run(BACKPORT, [spec, '--out', join(workspace, 'api'), '--types', join(workspace, 'api.types.ts'), '--force'])
    assert.equal(third.code, 0, third.stderr)
    assert.equal(await readFile(route, 'utf8'), generated)
  })

  await it('exits 1 for a handler mode this build does not implement', async () => {
    const result = await run(BACKPORT, [join(FIXTURE, 'openapi.json'), '--handlers', 'keep', '--out', await mkdtemp(join(tmpdir(), 'api-bp-'))])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /not implemented/)
  })
})
