#!/usr/bin/env node

/**
 * `api-server` — serve an `api/` folder over HTTP.
 * Reference: docs/CONTRIBUTING/CLI.md.
 */

import { resolve } from 'node:path'
import { createServer, discoverRoutes } from '../src/server/main.ts'
import { CliError, EXIT, flag, main, text, type ExitCode, type Io, type Parsed } from './lib/cli.ts'
import { loadConfig } from './lib/config.ts'
import { SERVE } from './lib/spec.ts'

interface Resolved {
  dir: string
  port: number
  host: string
  spec: string | undefined
  validate: boolean
  basePath: string | undefined
}

/**
 * Resolves the port. `--port` wins over `PORT`, which wins over the default, so a shell that
 * exports `PORT` for everything can still be overridden for one run.
 */
function resolvePort(parsed: Parsed): number {
  const raw = text(parsed, 'port') ?? process.env.PORT
  if (raw === undefined) return 3000
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliError(`invalid port ${JSON.stringify(raw)}; expected an integer between 0 and 65535`, EXIT.usage, true)
  }
  return port
}

async function resolveOptions(parsed: Parsed): Promise<Resolved> {
  const { config } = await loadConfig(text(parsed, 'config'))

  return {
    dir: parsed.positionals[0] ?? config.dir ?? './api',
    port: resolvePort(parsed),
    host: text(parsed, 'host') ?? process.env.HOST ?? '127.0.0.1',
    spec: text(parsed, 'spec') ?? config.out,
    validate: flag(parsed, 'validate'),
    basePath: text(parsed, 'base-path') ?? config.basePath,
  }
}

async function serve(options: Resolved, io: Io): Promise<ExitCode> {
  // Validation needs a specification: an Operation type is erased by the time the server runs.
  if (options.validate && options.spec === undefined) {
    io.err('--validate needs a specification; pass --spec <file> or set `out` in api.config.ts')
    return EXIT.usage
  }

  // Checked before the server is built. `createServer` loads routes asynchronously, so
  // `server.router.routes` is still empty at this point — and scanning first also turns a missing
  // folder into a clear message instead of a stack trace.
  const dir = resolve(options.dir)
  const discovered = await discoverRoutes(dir).catch((cause: unknown) => {
    const reason = cause instanceof Error && 'code' in cause && cause.code === 'ENOENT' ? 'does not exist' : `could not be read: ${cause instanceof Error ? cause.message : String(cause)}`
    throw new CliError(`${options.dir} ${reason}`, EXIT.failed)
  })

  if (discovered.length === 0) {
    io.err(`no route modules found in ${options.dir}`)
    return EXIT.failed
  }

  const server = createServer({
    routes: dir,
    ...(options.spec !== undefined && options.validate ? { spec: resolve(options.spec), validate: true } : {}),
    ...(options.basePath !== undefined ? { basePath: options.basePath } : {}),
  })

  /**
   * Registered before listening, deliberately.
   *
   * Until a handler exists, Node's default action for `SIGTERM` is to kill the process, so a
   * supervisor that starts the server and signals it immediately would get an unclean death. The
   * window is small but real: anything reading the startup banner and reacting to it lands in it.
   */
  let stopping = false
  const stopped = new Promise<void>((settle) => {
    const stop = (): void => {
      if (stopping) return
      stopping = true
      void server.close().then(
        () => {
          io.err('Stopped.')
          settle()
        },
        // Already closed, or never opened. Either way this process is done.
        () => settle(),
      )
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })

  const address = await server.listen(options.port, options.host)
  io.err(`Serving ${options.dir} on http://${options.host}:${address.port}`)
  for (const route of server.router.routes) io.err(`  ${route.method.padEnd(7)} ${route.path}`)

  // Stays alive until stopped, which is what makes this a server rather than a script.
  await stopped
  return EXIT.ok
}

await main(SERVE, process.argv.slice(2), async (parsed, io) => serve(await resolveOptions(parsed), io))
