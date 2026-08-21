#!/usr/bin/env node

/**
 * `api-backport` — generate an `api/` folder from an OpenAPI document.
 * Reference: docs/CONTRIBUTING/CLI.md.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseDocument } from '../src/openapi/main.ts'
import { emitAll, emitApiTypes } from '../src/typescript/main.ts'
import { CliError, EXIT, flag, main, notImplemented, rejectUnimplemented, text, type ExitCode, type Parsed } from './lib/cli.ts'
import { loadConfig } from './lib/config.ts'
import { BACKPORT } from './lib/spec.ts'

interface Resolved {
  spec: string
  out: string
  types: string | null
  schemas: string | undefined
  handlers: 'keep' | 'stub' | 'throw'
  force: boolean
}

async function resolveOptions(parsed: Parsed): Promise<Resolved> {
  const { config } = await loadConfig(text(parsed, 'config'))

  const [spec] = parsed.positionals
  if (/^https?:/i.test(spec)) throw notImplemented('http(s) specification sources')
  if (/\.ya?ml$/i.test(spec)) throw notImplemented('format yaml')

  const handlers = text(parsed, 'handlers') ?? config.handlers ?? 'throw'
  if (handlers !== 'throw') throw notImplemented(`handlers ${handlers}`)

  const typesFlag = text(parsed, 'types')
  if (typesFlag !== undefined && flag(parsed, 'no-types')) throw new CliError('--types and --no-types contradict each other', EXIT.usage, true)

  return {
    spec,
    out: text(parsed, 'out') ?? config.out ?? './api',
    types: flag(parsed, 'no-types') ? null : (typesFlag ?? config.types ?? './api.types.ts'),
    schemas: text(parsed, 'schemas') ?? config.schemas,
    handlers,
    force: flag(parsed, 'force'),
  }
}

async function exists(file: string): Promise<boolean> {
  return stat(file)
    .then((s) => s.isFile())
    .catch(() => false)
}

async function write(file: string, contents: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, contents, 'utf8')
}

await main(BACKPORT, process.argv.slice(2), async (parsed, io): Promise<ExitCode> => {
  rejectUnimplemented(BACKPORT, parsed)
  const options = await resolveOptions(parsed)

  const document = parseDocument(await readFile(options.spec, 'utf8'))
  const files = emitAll(document, { handlers: options.handlers })

  const out = resolve(options.out)
  let refused = 0

  for (const file of files) {
    // `schemas.ts` is a generated artefact rather than a route module, so it is always rewritten
    // and is never subject to --force.
    const isRoute = file.path !== 'schemas.ts'
    const target = file.path === 'schemas.ts' && options.schemas ? resolve(options.schemas) : join(out, file.path)

    if (isRoute && !options.force && (await exists(target))) {
      // Per-file, not whole-set: everything that did not exist is still written.
      io.err(`Left ${target} alone; pass --force to overwrite it`)
      refused++
      continue
    }

    await write(target, file.text)
    if (!io.silent) io.err(`Wrote ${target}`)
  }

  if (options.types !== null) {
    await write(resolve(options.types), emitApiTypes(document))
    if (!io.silent) io.err(`Wrote ${resolve(options.types)}`)
  }

  if (refused > 0) {
    io.err(`Refused to overwrite ${refused} existing route file${refused === 1 ? '' : 's'}.`)
    return EXIT.refused
  }
  return EXIT.ok
})
