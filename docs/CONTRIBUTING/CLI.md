# API

## Command Line

Two commands, one per direction:

Two commands move between the two representations, and a third runs one of them:

| Command        | Purpose                                  |
| -------------- | ---------------------------------------- |
| `api-port`     | `api/` → `openapi.json` + `api.types.ts` |
| `api-backport` | `openapi.json` → `api/` + `api.types.ts` |
| `api-server`   | Serve an `api/` folder over HTTP         |

The two porting commands share the same spec model, so the round trip is stable in either order.
All three read `api.config.ts` when present.

---

## `api-port`

Reads an `api/` folder, extracts each route module's `Operation` type with the TypeScript
compiler, and writes an OpenAPI 3.1 document.

```bash
api-port [options] [<dir>]
```

`<dir>` is the `api/` folder, defaulting to `./api`.

### Options

| Option                   | Default               | Description                                                                   |
| ------------------------ | --------------------- | ----------------------------------------------------------------------------- |
| `-o, --out <file>`       | `./openapi.json`      | Where to write the document. `-` writes to stdout.                            |
| `-t, --types <file>`     | `./api.types.ts`      | Where to write `api.types.ts`.                                                |
| `--no-types`             |                       | Skip `api.types.ts`.                                                          |
| `--format <json\|yaml>`  | inferred from `--out` | Output format.                                                                |
| `--title <string>`       | package name          | `info.title`.                                                                 |
| `--api-version <string>` | package version       | `info.version`.                                                               |
| `--description <string>` |                       | `info.description`.                                                           |
| `--server <url>`         |                       | Adds to `servers`. Repeatable.                                                |
| `--base-path <path>`     | `/`                   | Prefix for every path.                                                        |
| `--project <file>`       | `./tsconfig.json`     | The tsconfig to resolve types against.                                        |
| `--check`                |                       | Write nothing; exit non-zero if the output would differ from what is on disk. |
| `--watch`                |                       | Regenerate on change.                                                         |
| `--silent`               |                       | Suppress warnings.                                                            |
| `-c, --config <file>`    | `./api.config.ts`     | Configuration file.                                                           |
| `-h, --help`             |                       |                                                                               |
| `-v, --version`          |                       |                                                                               |

### Example

Given the route module and schemas from [API_FOLDER.md](./API_FOLDER.md):

```bash
api-port ./api --title 'Users API' --api-version 1.0.0
```

`openapi.json`:

```json
{
  "openapi": "3.1.0",
  "info": { "title": "Users API", "version": "1.0.0" },
  "paths": {
    "/users/{userId}": {
      "get": {
        "operationId": "getUser",
        "summary": "Fetch a single user by id.",
        "tags": ["users"],
        "parameters": [
          {
            "name": "userId",
            "in": "path",
            "required": true,
            "schema": { "type": "string", "format": "uuid" }
          },
          {
            "name": "include",
            "in": "query",
            "required": false,
            "schema": { "type": "string", "enum": ["orders", "profile"] }
          },
          {
            "name": "x-request-id",
            "in": "header",
            "required": false,
            "schema": { "type": "string" }
          }
        ],
        "responses": {
          "200": {
            "description": "OK",
            "content": {
              "application/json": { "schema": { "$ref": "#/components/schemas/User" } }
            }
          },
          "404": {
            "description": "Not Found",
            "content": {
              "application/json": { "schema": { "$ref": "#/components/schemas/ApiError" } }
            }
          }
        }
      }
    }
  },
  "components": {
    "schemas": {
      "ApiError": {
        "type": "object",
        "description": "A failed request.",
        "properties": {
          "code": { "type": "string" },
          "message": { "type": "string" }
        },
        "required": ["code", "message"],
        "additionalProperties": false
      },
      "User": {
        "type": "object",
        "description": "A registered user.",
        "properties": {
          "createdAt": { "type": "string", "format": "date-time" },
          "email": { "type": "string", "format": "email" },
          "id": { "type": "string", "format": "uuid" },
          "name": { "type": "string" },
          "role": { "type": "string", "enum": ["admin", "member"] }
        },
        "required": ["createdAt", "email", "id", "name", "role"],
        "additionalProperties": false
      }
    }
  }
}
```

Every collection above is in the canonical order defined in
[Ordering](./TYPE_MAPPING.md#ordering), which is what makes the output diffable and `--check`
meaningful.

This block is authoritative for **ordering and content, not whitespace**. Line breaking is an
implementation detail of the writer; do not assert these exact bytes.

### `--check`

Regenerates in memory and compares against `--out` and `--types`. Exit code `3` on any
difference, with a diff on stderr. This is the CI guard against a route module changing
without the spec being regenerated.

```yaml
- run: npx api-port ./api --check
```

---

## `api-backport`

Reads an OpenAPI document and writes the `api/` folder for it.

```bash
api-backport [options] <spec>
```

`<spec>` is a path or an `http(s)` URL. JSON and YAML are both accepted. External `$ref`s are
resolved and inlined.

### Options

| Option                           | Default            | Description                                                                  |
| -------------------------------- | ------------------ | ---------------------------------------------------------------------------- |
| `-o, --out <dir>`                | `./api`            | The `api/` folder to write.                                                  |
| `-t, --types <file>`             | `./api.types.ts`   | Where to write `api.types.ts`.                                               |
| `--no-types`                     |                    | Skip `api.types.ts`.                                                         |
| `--types-only`                   |                    | Write only `api.types.ts`. Use this for a client against someone else's API. |
| `--schemas <file>`               | `<out>/schemas.ts` | Where to write shared schemas.                                               |
| `--handlers <throw\|stub\|keep>` | `throw`            | Body for generated handlers. See below.                                      |
| `--only <glob>`                  |                    | Include only matching paths. Repeatable.                                     |
| `--exclude <glob>`               |                    | Exclude matching paths. Repeatable.                                          |
| `--force`                        |                    | Overwrite existing route files.                                              |
| `--prune`                        |                    | Delete route files with no corresponding operation.                          |
| `--silent`                       |                    | Suppress warnings.                                                           |
| `-c, --config <file>`            | `./api.config.ts`  | Configuration file.                                                          |
| `-h, --help`                     |                    |                                                                              |
| `-v, --version`                  |                    |                                                                              |

### Handler bodies

| Mode    | Generated body                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------- |
| `throw` | `throw new HttpError(501, { code: 'not_implemented', … })` — the default, so an unimplemented route fails loudly.         |
| `stub`  | Returns the first declared success response, populated from the schema's examples and defaults. Useful for a mock server. |
| `keep`  | Preserves the existing handler body and rewrites only the `Operation` type and imports.                                   |

`keep` is the mode for an evolving upstream spec: re-run it whenever the spec changes and your
implementations survive. It is why route modules should stay thin — see
[API_FOLDER.md](./API_FOLDER.md).

`keep` requires `--force`, because it rewrites a file that already exists. Where the target does
not exist there is no body to keep, so it falls back to `throw`. `keep` needs to locate the
`export interface Operation` declaration; if a route module has been reshaped so that it cannot
be found unambiguously, the file is left untouched and reported, and the run exits `1` — no
`--force` can make an unparseable module safe to rewrite.

### Overwriting

Without `--force`, an existing route file is left alone and reported, the files that did not
exist are still written, and the run exits `4`. With `--force`, existing files are rewritten,
which discards handler bodies unless `--handlers keep`.

`api.types.ts` and `api/schemas.ts` are generated artefacts rather than route modules: they are
always rewritten and are never subject to `--force`.

Naming is deterministic: `/users/{userId}` with `get` is always `api/users/[userId]/get.ts`. A
path segment that is not a valid directory name is percent-decoded and, if still unusable, is
an error naming the path.

### Example

```bash
api-backport https://api.example.com/openapi.json --out ./api --handlers keep
```

```text
api/
├── schemas.ts
└── users/
    └── [userId]/
        └── get.ts
api.types.ts
```

The generated `api.types.ts` is documented in [CLIENT.md](./CLIENT.md).

---

---

## `api-server`

Loads an `api/` folder and serves it.

```bash
api-server [options] [<dir>]
```

`<dir>` is the `api/` folder, defaulting to `./api`.

### Options

| Option                | Default           | Description                                          |
| --------------------- | ----------------- | ---------------------------------------------------- |
| `-p, --port <number>` | `3000`            | Port to listen on. Falls back to `$PORT`, then 3000. |
| `--host <host>`       | `127.0.0.1`       | Interface to bind. Falls back to `$HOST`.            |
| `--spec <file>`       | `out` from config | Specification to validate requests against.          |
| `--validate`          |                   | Validate requests against the specification.         |
| `--base-path <path>`  |                   | Prefix stripped before matching.                     |
| `--silent`            |                   | Suppress the startup banner and warnings.            |
| `-c, --config <file>` | `./api.config.ts` | Configuration file.                                  |
| `-h, --help`          |                   |                                                      |
| `-v, --version`       |                   |                                                      |

`--port 0` binds an ephemeral port, which the startup line then reports — useful in tests and
wherever the port is assigned rather than chosen.

Validation is opt-in and needs a specification, because an `Operation` type does not survive to
runtime. `--validate` without `--spec` and without an `out` in the configuration is a usage error
rather than a silently unvalidated server.

### Example

```bash
api-server ./api --port 8080 --spec ./openapi.json --validate
```

```text
Serving ./api on http://127.0.0.1:8080
  GET     /health
```

The banner and the route list go to stderr, so stdout stays clean.

`SIGINT` and `SIGTERM` stop the server, waiting for in-flight requests before the process exits. The
handlers are installed before the port is bound, so a supervisor that starts the server and signals
it immediately still gets a clean shutdown.

The folder is scanned before anything binds. A path that does not exist, and a path that holds no
route modules, both exit `1` — a server that accepts connections while answering nothing hides a
misconfiguration rather than reporting it.

### Container image

The same command is published as an image, which carries the package and no application code:

```bash
docker run --rm -p 3000:3000 -v "$PWD/api:/api:ro" ghcr.io/plushveil/api
```

Mount the folder to serve at `/api`. `PORT` and `HOST` are read from the environment, and the
container binds `0.0.0.0` so the published port is reachable. See [RELEASE.md](../RELEASE.md).

---

## Configuration

All three commands read `./api.config.ts` unless `--config` says otherwise. Command line options
win over the file.

```ts
// api.config.ts
import type { Config } from '@plushveil/api'

export default {
  dir: './api',
  out: './openapi.json',
  types: './api.types.ts',

  title: 'Users API',
  version: '1.0.0',
  description: 'Accounts and sessions.',
  servers: ['https://api.example.com'],
  basePath: '/v1',

  securitySchemes: {
    bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
  },

  handlers: 'keep',
} satisfies Config
```

`securitySchemes` is document-scoped and has no route-module equivalent; route modules
reference these names with `@security`, as described in [TYPE_MAPPING.md](./TYPE_MAPPING.md).
`api-backport` writes any schemes it finds in a spec back into this file.

## Exit Codes

| Code | Meaning                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success.                                                                                                                     |
| `1`  | An unsupported type, an invalid spec, an unreadable route module, or a requested feature that this build does not implement. |
| `2`  | Bad usage — an unknown option, a missing argument, an invalid flag value, or two flags that contradict each other.           |
| `3`  | `--check` found a difference.                                                                                                |
| `4`  | Refused to overwrite existing route files; pass `--force`.                                                                   |

Warnings go to stderr and do not change the exit code.

`api-server` uses `0`, `1`, and `2` only; `3` and `4` belong to the porting commands.

A flag that is documented here but not yet implemented still parses and validates — it is never
reported as an unknown option, because that would be an exit-`2` lie. It fails with exit `1` and
a message naming the flag. Everything documented in this file is expected to work eventually;
consult `--help` for what the build in front of you actually supports.
