#!/usr/bin/env node

/**
 * `api-port` — generate an OpenAPI document from an `api/` folder.
 * Reference: docs/CONTRIBUTING/CLI.md.
 */

import { watch } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { diff, stringify } from '../src/openapi/main.ts'
import { emitApiTypes, extractRoutes } from '../src/typescript/main.ts'
import { CliError, EXIT, flag, list, main, notImplemented, rejectUnimplemented, text, type ExitCode, type Io, type Parsed } from './lib/cli.ts'
import { loadConfig } from './lib/config.ts'
import { PORT } from './lib/spec.ts'

const STDOUT = '-'

interface Resolved {
  dir: string
  out: string
  types: string | null
  project: string
  title: string
  version: string
  description?: string
  servers?: string[]
  basePath: string
  check: boolean
  watch: boolean
}

/**
 * `info.title` and `info.version` default to the package's own, as CLI.md documents. They must
 * have a value: OpenAPI requires both, and the committed artefacts have to be reproducible from
 * `api-port ./api` with no flags at all, or the documented `--check` guard cannot pass.
 */
function readManifest(contents: string): { name?: string; version?: string } {
  const parsed: unknown = JSON.parse(contents)
  if (typeof parsed !== 'object' || parsed === null) return {}
  const record: Record<string, unknown> = { ...parsed }
  return {
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
    ...(typeof record.version === 'string' ? { version: record.version } : {}),
  }
}

async function packageInfo(): Promise<{ title: string; version: string }> {
  const manifest = await readFile(resolve('package.json'), 'utf8')
    .then((contents) => readManifest(contents))
    .catch((): { name?: string; version?: string } => ({}))
  return { title: manifest.name ?? 'api', version: manifest.version ?? '0.0.0' }
}

async function resolveOptions(parsed: Parsed): Promise<Resolved> {
  const { config } = await loadConfig(text(parsed, 'config'))
  const fallback = await packageInfo()

  if (text(parsed, 'format') === 'yaml' || config.format === 'yaml') throw notImplemented('format yaml')
  if (flag(parsed, 'types') && flag(parsed, 'no-types')) throw new CliError('--types and --no-types contradict each other', EXIT.usage, true)

  const typesFlag = text(parsed, 'types')
  if (typesFlag !== undefined && flag(parsed, 'no-types')) throw new CliError('--types and --no-types contradict each other', EXIT.usage, true)

  const out = text(parsed, 'out') ?? config.out ?? './openapi.json'
  const check = flag(parsed, 'check')
  if (check && out === STDOUT) throw new CliError('--check cannot be combined with --out -', EXIT.usage, true)

  const types = flag(parsed, 'no-types') ? null : (typesFlag ?? config.types ?? './api.types.ts')
  if (types === STDOUT) throw new CliError('--types - is not supported; name a file', EXIT.usage, true)

  return {
    dir: parsed.positionals[0] ?? config.dir ?? './api',
    out,
    types,
    project: text(parsed, 'project') ?? config.project ?? './tsconfig.json',
    title: text(parsed, 'title') ?? config.title ?? fallback.title,
    version: text(parsed, 'api-version') ?? config.version ?? fallback.version,
    description: text(parsed, 'description') ?? config.description,
    servers: list(parsed, 'server') ?? config.servers,
    basePath: text(parsed, 'base-path') ?? config.basePath ?? '/',
    check,
    watch: flag(parsed, 'watch'),
  }
}

interface Generated {
  spec: string
  types: string | undefined
}

async function generate(options: Resolved): Promise<Generated> {
  const { document } = await extractRoutes(options.dir, {
    project: options.project,
    title: options.title,
    version: options.version,
    description: options.description,
    servers: options.servers,
    basePath: options.basePath,
  })

  return {
    spec: stringify(document),
    types: options.types === null ? undefined : emitApiTypes(document),
  }
}

async function readOrUndefined(file: string): Promise<string | undefined> {
  return readFile(file, 'utf8').catch(() => undefined)
}

async function writeArtefact(file: string, contents: string): Promise<void> {
  await mkdir(dirname(resolve(file)), { recursive: true })
  await writeFile(file, contents, 'utf8')
}

/**
 * `--check`: regenerate in memory and compare both artefacts to disk.
 */
async function runCheck(options: Resolved, generated: Generated, io: Io): Promise<ExitCode> {
  const targets: [string, string][] = [[options.out, generated.spec]]
  if (options.types !== null && generated.types !== undefined) targets.push([options.types, generated.types])

  let drifted = false
  for (const [file, expected] of targets) {
    const actual = await readOrUndefined(file)
    if (actual === undefined) {
      io.err(`${file} does not exist`)
      drifted = true
      continue
    }
    // The diff is never suppressed by --silent: it is the reason for the exit code.
    const report = diff(actual, expected, { from: file, to: 'generated' })
    if (report) {
      io.err(report)
      drifted = true
    }
  }

  if (drifted) {
    io.err('The generated output differs from what is on disk. Re-run api-port to update it.')
    return EXIT.drift
  }
  if (!io.silent) io.err('Up to date.')
  return EXIT.ok
}

async function runOnce(options: Resolved, io: Io): Promise<ExitCode> {
  const generated = await generate(options)

  if (options.check) return runCheck(options, generated, io)

  if (options.out === STDOUT) {
    process.stdout.write(generated.spec)
  } else {
    await writeArtefact(options.out, generated.spec)
    if (!io.silent) io.err(`Wrote ${options.out}`)
  }

  if (options.types !== null && generated.types !== undefined) {
    await writeArtefact(options.types, generated.types)
    if (!io.silent) io.err(`Wrote ${options.types}`)
  }

  return EXIT.ok
}

/**
 * `--watch`: coalesce bursts, never run two at once, keep going after a failure.
 */
async function runWatch(options: Resolved, io: Io): Promise<ExitCode> {
  let running = false
  let queued = false
  let timer: NodeJS.Timeout | undefined = undefined

  const cycle = async (): Promise<void> => {
    if (running) {
      queued = true
      return
    }
    running = true
    try {
      await runOnce(options, io)
    } catch (error) {
      io.err(`api-port: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      running = false
      if (queued) {
        queued = false
        void cycle()
      }
    }
  }

  await cycle()

  const ignored = new Set([resolve(options.out), options.types === null ? '' : resolve(options.types)])
  const watcher = watch(options.dir, { recursive: true }, (_event, filename) => {
    if (!filename) return
    if (!filename.endsWith('.ts')) return
    if (filename.endsWith('.test.ts') || filename.split('/').pop()?.startsWith('_')) return
    if (ignored.has(resolve(options.dir, filename))) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void cycle(), 100)
  })

  io.err(`Watching ${options.dir} for changes. Press Ctrl+C to stop.`)
  await new Promise<void>((settle) => {
    process.once('SIGINT', () => {
      watcher.close()
      settle()
    })
  })
  return EXIT.ok
}

await main(PORT, process.argv.slice(2), async (parsed, io) => {
  rejectUnimplemented(PORT, parsed)
  const options = await resolveOptions(parsed)
  return options.watch ? runWatch(options, io) : runOnce(options, io)
})
