/**
 * Loading `api.config.ts`.
 *
 * The file is TypeScript, which Node runs directly under type stripping, so it is imported rather
 * than parsed. Paths inside it resolve relative to the file; paths from flags resolve relative to
 * the working directory.
 */

import { stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CliError, EXIT } from './cli.ts'
import type { Json } from '../../src/openapi/main.ts'

/** The documented configuration surface. */
export interface Config {
  dir?: string
  out?: string
  types?: string
  schemas?: string
  format?: 'json' | 'yaml'
  project?: string
  title?: string
  version?: string
  description?: string
  servers?: string[]
  basePath?: string
  securitySchemes?: Record<string, Json>
  handlers?: 'keep' | 'stub' | 'throw'
  only?: string[]
  exclude?: string[]
}

export interface LoadedConfig {
  config: Config
  /** Directory the config was found in, for resolving its relative paths. */
  dir: string
  /** Absent when no config file existed. */
  file?: string
}

const PATH_KEYS = ['dir', 'out', 'types', 'schemas', 'project'] as const

/**
 * Loads a config file. A missing default file is not an error; a missing explicit one is, because
 * the user named it.
 */
export async function loadConfig(file: string | undefined, cwd = process.cwd()): Promise<LoadedConfig> {
  const explicit = file !== undefined
  const target = resolve(cwd, file ?? 'api.config.ts')

  const exists = await stat(target).then((s) => s.isFile()).catch(() => false)
  if (!exists) {
    if (explicit) throw new CliError(`the configuration file ${target} does not exist`, EXIT.usage)
    return { config: {}, dir: cwd }
  }

  let module: { default?: unknown }
  try {
    module = (await import(pathToFileURL(target).href)) as { default?: unknown }
  } catch (cause) {
    throw new CliError(`could not load ${target}: ${cause instanceof Error ? cause.message : String(cause)}`, EXIT.failed)
  }

  const value = module.default
  if (value === undefined) throw new CliError(`${target} must have a default export`, EXIT.failed)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CliError(`${target} must default-export an object`, EXIT.failed)

  const dir = dirname(target)
  const config = { ...(value as Config) }
  for (const key of PATH_KEYS) {
    const raw = config[key]
    if (typeof raw === 'string' && !isAbsolute(raw)) config[key] = resolve(dir, raw)
  }

  return { config, dir, file: target }
}
