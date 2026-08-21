/**
 * `@plushveil/api` — keep an OpenAPI specification and a TypeScript implementation in sync, in
 * both directions.
 *
 * The two runtime packages are separate entry points, so importing one never drags in the other:
 *
 * - `@plushveil/api/server` — HTTP server, router, middleware
 * - `@plushveil/api/client` — type-safe consumer
 *
 * This entry point carries only what both CLIs share. See docs/README.md.
 */

export type { Config } from '../bin/lib/config.ts'
export type { Document, Json, Method, Schema } from './openapi/main.ts'
