/**
 * One declarative option table per command. Both the `parseArgs` configuration and the `--help`
 * text are derived from it, so a flag cannot exist in one and be missing from the other.
 */

export interface OptionSpec {
  name: string
  short?: string
  /** Absent for a boolean flag. */
  argument?: string
  description: string
  default?: string
  /** Permitted values, validated before anything runs. */
  values?: string[]
  /** May be given more than once. */
  multiple?: boolean
  /** Parses and validates, then fails with exit 1 rather than pretending to work. */
  unimplemented?: boolean
}

export interface CommandSpec {
  name: string
  summary: string
  usage: string
  positional: { name: string, required: boolean, description: string }
  options: OptionSpec[]
}

const COMMON: OptionSpec[] = [
  { name: 'silent', description: 'Suppress warnings.' },
  { name: 'config', short: 'c', argument: 'file', description: 'Configuration file.', default: './api.config.ts' },
  { name: 'help', short: 'h', description: 'Show this help.' },
  { name: 'version', short: 'v', description: 'Show the version.' },
]

export const PORT: CommandSpec = {
  name: 'api-port',
  summary: 'Generate an OpenAPI document from an api/ folder.',
  usage: 'api-port [options] [<dir>]',
  positional: { name: 'dir', required: false, description: 'The api/ folder. Defaults to ./api.' },
  options: [
    { name: 'out', short: 'o', argument: 'file', description: 'Where to write the document. `-` writes to stdout.', default: './openapi.json' },
    { name: 'types', short: 't', argument: 'file', description: 'Where to write api.types.ts.', default: './api.types.ts' },
    { name: 'no-types', description: 'Skip api.types.ts.' },
    { name: 'format', argument: 'json|yaml', description: 'Output format.', values: ['json', 'yaml'], default: 'json' },
    { name: 'title', argument: 'string', description: 'info.title.' },
    { name: 'api-version', argument: 'string', description: 'info.version.' },
    { name: 'description', argument: 'string', description: 'info.description.' },
    { name: 'server', argument: 'url', description: 'Adds to servers. Repeatable.', multiple: true },
    { name: 'base-path', argument: 'path', description: 'Prefix for every path.', default: '/' },
    { name: 'project', argument: 'file', description: 'The tsconfig to resolve types against.', default: './tsconfig.json' },
    { name: 'check', description: 'Write nothing; exit 3 if the output would differ from disk.' },
    { name: 'watch', description: 'Regenerate on change.' },
    ...COMMON,
  ],
}

export const SERVE: CommandSpec = {
  name: 'api-server',
  summary: 'Serve an api/ folder over HTTP.',
  usage: 'api-server [options] [<dir>]',
  positional: { name: 'dir', required: false, description: 'The api/ folder to serve. Defaults to ./api.' },
  options: [
    { name: 'port', short: 'p', argument: 'number', description: 'Port to listen on. Falls back to $PORT, then 3000.', default: '3000' },
    { name: 'host', argument: 'host', description: 'Interface to bind. Falls back to $HOST.', default: '127.0.0.1' },
    { name: 'spec', argument: 'file', description: 'Specification to validate requests against.' },
    { name: 'validate', description: 'Validate requests against the specification.' },
    { name: 'base-path', argument: 'path', description: 'Prefix stripped before matching.' },
    ...COMMON,
  ],
}

export const BACKPORT: CommandSpec = {
  name: 'api-backport',
  summary: 'Generate an api/ folder from an OpenAPI document.',
  usage: 'api-backport [options] <spec>',
  positional: { name: 'spec', required: true, description: 'Path to an OpenAPI document.' },
  options: [
    { name: 'out', short: 'o', argument: 'dir', description: 'The api/ folder to write.', default: './api' },
    { name: 'types', short: 't', argument: 'file', description: 'Where to write api.types.ts.', default: './api.types.ts' },
    { name: 'no-types', description: 'Skip api.types.ts.' },
    { name: 'types-only', description: 'Write only api.types.ts.', unimplemented: true },
    { name: 'schemas', argument: 'file', description: 'Where to write shared schemas.', default: '<out>/schemas.ts' },
    { name: 'handlers', argument: 'throw|stub|keep', description: 'Body for generated handlers.', values: ['throw', 'stub', 'keep'], default: 'throw' },
    { name: 'only', argument: 'glob', description: 'Include only matching paths. Repeatable.', multiple: true, unimplemented: true },
    { name: 'exclude', argument: 'glob', description: 'Exclude matching paths. Repeatable.', multiple: true, unimplemented: true },
    { name: 'force', description: 'Overwrite existing route files.' },
    { name: 'prune', description: 'Delete route files with no corresponding operation.', unimplemented: true },
    ...COMMON,
  ],
}
