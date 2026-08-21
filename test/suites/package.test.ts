/**
 * Proves the published artefact is usable by an ordinary consumer.
 *
 * Nothing else in this suite can: inside the repository, `@plushveil/api/server` resolves through
 * the `exports` self-reference to the repository root and never touches `node_modules`. That is
 * exactly the path a consumer does not take, and it is why shipping TypeScript sources looked fine
 * for so long while being unusable once installed.
 *
 * So this packs a real tarball, installs it into a throwaway project, and uses it from there.
 */

import * as assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, describe, it } from 'node:test'
import { isRecord } from '../helpers/json.ts'

const root = new URL('../../', import.meta.url).pathname
const FIXTURE = join(root, 'test/fixtures/api-health')

interface Run {
  code: number
  stdout: string
  stderr: string
}

function run(command: string, args: string[], cwd: string): Promise<Run> {
  return new Promise((settle, fail) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', fail)
    child.on('close', (code) => settle({ code: code ?? -1, stdout, stderr }))
  })
}

const node = process.execPath

let workspace = ''
let tarball = ''

await describe('the published package', async () => {
  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'api-consumer-'))

    // `npm pack` runs `prepack`, so this is the same artefact `npm publish` would upload.
    const packed = await run('npm', ['pack', '--pack-destination', workspace], root)
    assert.equal(packed.code, 0, packed.stderr)

    const produced = (await readdir(workspace)).filter((name) => name.endsWith('.tgz'))
    const [only] = produced
    assert.equal(produced.length, 1, `expected one tarball, got ${produced.join(', ')}`)
    assert.ok(only)
    tarball = join(workspace, only)

    await writeFile(join(workspace, 'package.json'), `${JSON.stringify({ name: 'consumer', version: '1.0.0', type: 'module', private: true }, null, 2)}\n`, 'utf8')

    // Offline: the package has no runtime dependencies, so nothing needs fetching.
    const installed = await run('npm', ['install', tarball, '--no-audit', '--no-fund', '--offline'], workspace)
    assert.equal(installed.code, 0, installed.stderr)

    // A realistic consumer also has the optional peer and node's own types. Linked rather than
    // installed, because this test must work without a registry.
    await mkdir(join(workspace, 'node_modules/@types'), { recursive: true })
    await symlink(join(root, 'node_modules/typescript'), join(workspace, 'node_modules/typescript'), 'dir')
    await symlink(join(root, 'node_modules/@types/node'), join(workspace, 'node_modules/@types/node'), 'dir')
  })

  await it('ships only dist, not sources or tests', async () => {
    // Reads the tarball packed in `before`, rather than packing again. `npm pack --dry-run` writes
    // the file regardless of its name, so running it here would leave a stray artefact in the
    // repository on every test run.
    const listed = await run('tar', ['-tzf', tarball], workspace)
    assert.equal(listed.code, 0, listed.stderr)

    // Every entry in an npm tarball is prefixed with `package/`.
    const paths = listed.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.endsWith('/'))
      .map((line) => line.replace(/^package\//, ''))

    assert.ok(paths.length > 0, 'expected the tarball to contain files')

    const allowed = (path: string): boolean => path.startsWith('dist/') || path === 'package.json' || path === 'LICENSE' || path.startsWith('README')
    assert.deepEqual(
      paths.filter((path) => !allowed(path)),
      [],
      'unexpected files in the tarball',
    )

    assert.ok(!paths.some((path) => path.startsWith('test/')), 'tests must not be published')
    assert.ok(!paths.some((path) => path.endsWith('.ts') && !path.endsWith('.d.ts')), 'untranspiled sources must not be published')
    assert.ok(paths.includes('dist/src/server/main.js'), 'the server entry point must be present')
    assert.ok(paths.includes('dist/src/server/main.d.ts'), 'the server declarations must be present')
  })

  await it('publishes without npm silently correcting the manifest', async () => {
    // npm normalises package.json on publish and drops what it considers invalid, quietly. A `./`
    // prefix on a `bin` value is the trap: npm strips it, rejects the result, and removes the
    // command — publishing a package whose binaries simply do not exist.
    const dry = await run('npm', ['publish', '--dry-run'], root)
    assert.equal(dry.code, 0, dry.stderr)
    assert.doesNotMatch(dry.stderr, /auto-corrected/, `npm rewrote the manifest:\n${dry.stderr}`)
    assert.doesNotMatch(dry.stderr, /invalid and removed/)
    assert.doesNotMatch(dry.stderr, /No bin file found/)
  })

  await it('can be imported from node_modules and serve a request', async () => {
    // The whole point: an installed copy lives under node_modules, where Node refuses to strip
    // types. Importing it at all proves the build made the package loadable.
    await writeFile(
      join(workspace, 'serve.mjs'),
      [
        `import { createServer } from '@plushveil/api/server'`,
        `const server = createServer({ routes: ${JSON.stringify(join(FIXTURE, 'api'))} })`,
        `const response = await server.fetch(new Request('http://localhost/health'))`,
        `process.stdout.write(JSON.stringify({ status: response.status, body: await response.json() }))`,
        '',
      ].join('\n'),
      'utf8',
    )

    const result = await run(node, ['serve.mjs'], workspace)
    assert.equal(result.code, 0, result.stderr)

    const reported: unknown = JSON.parse(result.stdout)
    assert.deepEqual(reported, { status: 200, body: { dependenciesReady: true, status: 'ok', uptime: 0 } })
  })

  await it('exposes the client entry point', async () => {
    await writeFile(
      join(workspace, 'client.mjs'),
      [
        `import { createClient, ApiRequestError } from '@plushveil/api/client'`,
        `const client = createClient({ baseUrl: 'http://localhost' })`,
        `process.stdout.write(JSON.stringify({ verbs: Object.keys(client).sort(), error: ApiRequestError.name }))`,
        '',
      ].join('\n'),
      'utf8',
    )

    const result = await run(node, ['client.mjs'], workspace)
    assert.equal(result.code, 0, result.stderr)
    const reported: unknown = JSON.parse(result.stdout)
    assert.ok(isRecord(reported))
    assert.deepEqual(reported.verbs, ['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'use'])
    assert.equal(reported.error, 'ApiRequestError')
  })

  await it('installs the three commands as runnable binaries', async () => {
    for (const command of ['api-port', 'api-backport', 'api-server']) {
      const result = await run(join(workspace, 'node_modules/.bin', command), ['--version'], workspace)
      assert.equal(result.code, 0, `${command}: ${result.stderr}`)
      assert.match(result.stdout.trim(), /^@plushveil\/api \d+\.\d+\.\d+$/)
    }
  })

  await it('ports a folder through the installed api-port', async () => {
    // Arranged the way a consumer's project actually looks: their own api/ folder and their own
    // tsconfig, both inside the project. Extraction resolves types through that tsconfig, so
    // pointing at a folder outside it would fail for reasons that have nothing to do with packaging.
    await mkdir(join(workspace, 'api/health'), { recursive: true })
    await copyFile(join(FIXTURE, 'api/schemas.ts'), join(workspace, 'api/schemas.ts'))
    await copyFile(join(FIXTURE, 'api/health/get.ts'), join(workspace, 'api/health/get.ts'))
    await writeFile(
      join(workspace, 'tsconfig.json'),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'nodenext',
            moduleResolution: 'nodenext',
            lib: ['ES2022'],
            strict: true,
            noEmit: true,
            allowImportingTsExtensions: true,
            types: ['node'],
          },
          include: ['api/**/*.ts'],
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    const out = join(workspace, 'openapi.json')
    const result = await run(join(workspace, 'node_modules/.bin/api-port'), ['./api', '--out', out, '--no-types', '--title', '@plushveil/api', '--api-version', '1.0.0'], workspace)

    assert.equal(result.code, 0, result.stderr)
    assert.equal(await readFile(out, 'utf8'), await readFile(join(FIXTURE, 'openapi.json'), 'utf8'))
  })

  await it('reports a missing typescript peer as a sentence, not a resolution crash', async () => {
    // `typescript` is an optional peer: serving and consuming never need it, porting does. A
    // consumer who skipped it should be told what to install.
    const bare = await mkdtemp(join(tmpdir(), 'api-nopeer-'))
    await writeFile(join(bare, 'package.json'), `${JSON.stringify({ name: 'bare', version: '1.0.0', type: 'module', private: true }, null, 2)}\n`, 'utf8')
    const installed = await run('npm', ['install', tarball, '--no-audit', '--no-fund', '--offline'], bare)
    assert.equal(installed.code, 0, installed.stderr)

    await mkdir(join(bare, 'api/health'), { recursive: true })
    await copyFile(join(FIXTURE, 'api/health/get.ts'), join(bare, 'api/health/get.ts'))

    const result = await run(join(bare, 'node_modules/.bin/api-port'), ['./api', '--out', join(bare, 'openapi.json'), '--no-types'], bare)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /needs the `typescript` package/)
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/)
  })

  await it('type-checks from a consumer project without allowImportingTsExtensions', async () => {
    // A consumer's tsconfig will not have that flag, and the emitted .d.ts files still carry `.ts`
    // specifiers. TypeScript resolves those to the sibling declarations, but only a real consumer
    // compile proves it.
    const project = join(workspace, 'typed')
    await mkdir(project, { recursive: true })
    await writeFile(
      join(project, 'tsconfig.json'),
      `${JSON.stringify(
        {
          compilerOptions: { target: 'ES2022', module: 'nodenext', moduleResolution: 'nodenext', lib: ['ES2022'], strict: true, noEmit: true, types: ['node'] },
          include: ['app.ts'],
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    await writeFile(
      join(project, 'app.ts'),
      [
        `import { createServer, HttpError } from '@plushveil/api/server'`,
        `import { createClient } from '@plushveil/api/client'`,
        ``,
        `interface Api {`,
        `  '/health': { get: { responses: { 200: { status: 'ok' } } } }`,
        `}`,
        ``,
        `export const server = createServer({ routes: './api' })`,
        `export const failure = new HttpError(404, { code: 'not_found' })`,
        `const client = createClient<Api>({ baseUrl: 'http://localhost' })`,
        `export const status = async (): Promise<string> => {`,
        `  const result = await client.get('/health')`,
        `  return result.status === 200 ? result.body.status : 'other'`,
        `}`,
        '',
      ].join('\n'),
      'utf8',
    )

    const tsc = join(root, 'node_modules/typescript/bin/tsc')
    const checked = await run(node, [tsc, '-p', 'tsconfig.json'], project)
    assert.equal(checked.code, 0, `${checked.stdout}\n${checked.stderr}`)
  })
})
