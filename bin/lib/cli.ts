/**
 * Argument parsing, help rendering, and the exit-code contract from
 * docs/CONTRIBUTING/CLI.md#exit-codes.
 *
 * The library is pure — options in, strings out. Every side effect lives in the command.
 */

import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { CommandSpec, OptionSpec } from './spec.ts'

/** The documented exit codes. `as const` matters: `Object.freeze` would widen these to `number`. */
export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  drift: 3,
  refused: 4,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

/** An error carrying the exit code it should produce. */
export class CliError extends Error {
  readonly code: ExitCode
  /** Print the usage line too, as a usage error should. */
  readonly usage: boolean

  constructor(message: string, code: ExitCode = EXIT.failed, usage = false) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.usage = usage
  }
}

/** Raised for a documented flag this build does not implement yet. */
export function notImplemented(flag: string): CliError {
  return new CliError(`--${flag} is documented but not implemented in this build`, EXIT.failed)
}

export interface Parsed {
  positionals: string[]
  values: Record<string, string | boolean | string[] | undefined>
}

/**
 * Parses argv against a command spec.
 *
 * `parseArgs` defaults are deliberately unused: leaving a value `undefined` is what lets a config
 * file supply it, and a default here would silently outrank the file.
 */
export function parse(spec: CommandSpec, argv: string[]): Parsed {
  const options: Record<string, { type: 'boolean' | 'string', short?: string, multiple?: boolean }> = {}
  for (const option of spec.options) {
    options[option.name] = {
      type: option.argument ? 'string' : 'boolean',
      ...(option.short ? { short: option.short } : {}),
      ...(option.multiple ? { multiple: true } : {}),
    }
  }

  let parsed
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true })
  } catch (cause) {
    throw new CliError(cause instanceof Error ? cause.message : String(cause), EXIT.usage, true)
  }

  for (const option of spec.options) {
    if (!option.values) continue
    const value = parsed.values[option.name]
    if (typeof value !== 'string') continue
    if (!option.values.includes(value)) {
      throw new CliError(`invalid value ${JSON.stringify(value)} for --${option.name}; expected ${option.values.join('|')}`, EXIT.usage, true)
    }
  }

  const positionals = parsed.positionals
  const max = 1
  if (positionals.length > max) throw new CliError(`unexpected argument ${JSON.stringify(positionals[max])}`, EXIT.usage, true)
  if (spec.positional.required && positionals.length === 0) throw new CliError(`missing required <${spec.positional.name}>`, EXIT.usage, true)

  return { positionals, values: parsed.values as Parsed['values'] }
}

/**
 * Detects `--help` and `--version` before anything else runs, so neither depends on a valid
 * config file or a well-formed rest of the command line. Stops at `--` so a positional that
 * happens to read `--help` is still a positional.
 */
export function preScan(argv: string[]): 'help' | 'version' | undefined {
  for (const argument of argv) {
    if (argument === '--') break
    if (argument === '--help' || argument === '-h') return 'help'
    if (argument === '--version' || argument === '-v') return 'version'
  }
  return undefined
}

/** Renders `--help` from the option table. */
export function help(spec: CommandSpec): string {
  const lines: string[] = ['', spec.summary, '', `Usage: ${spec.usage}`, '', 'Arguments:']
  lines.push(`  <${spec.positional.name}>`.padEnd(34) + spec.positional.description)
  lines.push('', 'Options:')

  for (const option of spec.options) {
    const flag = `${option.short ? `-${option.short}, ` : '    '}--${option.name}${option.argument ? ` <${option.argument}>` : ''}`
    const notes: string[] = []
    if (option.default) notes.push(`default: ${option.default}`)
    if (option.unimplemented) notes.push('not implemented yet')
    const suffix = notes.length > 0 ? ` (${notes.join('; ')})` : ''
    lines.push(`  ${flag.padEnd(32)}${option.description}${suffix}`)
  }

  lines.push('')
  return lines.join('\n')
}

/** Reads this package's version, for `--version`. */
export async function version(): Promise<string> {
  // Walked rather than counted. This file sits at bin/lib/ in the sources and at dist/bin/lib/ once
  // built, so a fixed number of `..` segments is right in exactly one of the two layouts.
  let directory = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = join(directory, 'package.json')
    const contents = await readFile(candidate, 'utf8').catch(() => undefined)
    if (contents !== undefined) {
      const manifest: unknown = JSON.parse(contents)
      const record = typeof manifest === 'object' && manifest !== null ? { ...manifest } : {}
      const name = 'name' in record && typeof record.name === 'string' ? record.name : 'api'
      const declared = 'version' in record && typeof record.version === 'string' ? record.version : '0.0.0'
      return `${name} ${declared}`
    }

    const parent = dirname(directory)
    if (parent === directory) throw new CliError('could not locate package.json to read the version from')
    directory = parent
  }
}

/** True when the flag was given. */
export function flag(parsed: Parsed, name: string): boolean {
  return parsed.values[name] === true
}

/** A string option, or undefined when absent. */
export function text(parsed: Parsed, name: string): string | undefined {
  const value = parsed.values[name]
  return typeof value === 'string' ? value : undefined
}

/** A repeatable option as an array. */
export function list(parsed: Parsed, name: string): string[] | undefined {
  const value = parsed.values[name]
  if (Array.isArray(value)) return value
  return typeof value === 'string' ? [value] : undefined
}

/** Rejects any unimplemented flag that was actually given. */
export function rejectUnimplemented(spec: CommandSpec, parsed: Parsed): void {
  for (const option of spec.options) {
    if (!option.unimplemented) continue
    const value = parsed.values[option.name]
    if (value === undefined || value === false) continue
    throw notImplemented(option.name)
  }
}

export interface Io {
  out: (text: string) => void
  err: (text: string) => void
  silent: boolean
}

export function createIo(silent: boolean): Io {
  return {
    out: (text) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`),
    // Everything that is not the requested artefact goes to stderr, so `--out -` stays pipeable.
    err: (text) => process.stderr.write(text.endsWith('\n') ? text : `${text}\n`),
    silent,
  }
}

/**
 * Runs a command, mapping any failure onto the documented exit code.
 *
 * Sets `process.exitCode` and returns rather than calling `process.exit`, so buffered stdout is
 * still flushed.
 */
export async function main(spec: CommandSpec, argv: string[], run: (parsed: Parsed, io: Io) => Promise<ExitCode>): Promise<void> {
  const early = preScan(argv)
  if (early === 'help') {
    process.stdout.write(`${help(spec)}\n`)
    return
  }
  if (early === 'version') {
    process.stdout.write(`${await version()}\n`)
    return
  }

  let io = createIo(false)
  try {
    const parsed = parse(spec, argv)
    io = createIo(flag(parsed, 'silent'))
    process.exitCode = await run(parsed, io)
  } catch (error) {
    if (error instanceof CliError) {
      io.err(`${spec.name}: ${error.message}`)
      if (error.usage) io.err(`Usage: ${spec.usage}`)
      process.exitCode = error.code
      return
    }
    io.err(`${spec.name}: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = EXIT.failed
  }
}
