# API

## Command Line

Two commands, one per direction:

| Command        | Direction                                |
| -------------- | ---------------------------------------- |
| `api-port`     | `api/` → `openapi.json` + `api.types.ts` |
| `api-backport` | `openapi.json` → `api/` + `api.types.ts` |

Both share the same spec model, so the round trip is stable in either order. Both read
`api.config.ts` when present.

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
            "schema": { "type": "string", "enum": ["profile", "orders"] }
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
      "User": {
        "type": "object",
        "description": "A registered user.",
        "properties": {
          "id": { "type": "string", "format": "uuid" },
          "email": { "type": "string", "format": "email" },
          "name": { "type": "string" },
          "createdAt": { "type": "string", "format": "date-time" },
          "role": { "type": "string", "enum": ["admin", "member"] }
        },
        "required": ["id", "email", "name", "createdAt", "role"],
        "additionalProperties": false
      },
      "ApiError": {
        "type": "object",
        "description": "A failed request.",
        "properties": {
          "code": { "type": "string" },
          "message": { "type": "string" }
        },
        "required": ["code", "message"],
        "additionalProperties": false
      }
    }
  }
}
```

Paths, parameters, properties, and component names are emitted in a stable order, so the
output is diffable.

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

### Overwriting

Without `--force`, an existing route file is left alone and reported. With `--force`, it is
rewritten, which discards handler bodies unless `--handlers keep`.

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

## Configuration

Both commands read `./api.config.ts` unless `--config` says otherwise. Command line options
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

| Code | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| `0`  | Success.                                                             |
| `1`  | An unsupported type, an invalid spec, or an unreadable route module. |
| `2`  | Bad usage — an unknown option or a missing argument.                 |
| `3`  | `--check` found a difference.                                        |
| `4`  | Refused to overwrite existing files; pass `--force`.                 |

Warnings go to stderr and do not change the exit code.
