# API

## Architecture

`@plushveil/api` treats the `api/` folder and `openapi.json` as two representations of one
contract. Either can be generated from the other, and neither is privileged.

### Packages

| Path              | Public specifier        | Responsibility                                                                                 |
| ----------------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| `src/server/`     | `@plushveil/api/server` | HTTP server, router, middleware, filesystem route loading, runtime validation.                 |
| `src/client/`     | `@plushveil/api/client` | Typed HTTP client driven by a generated `Api` interface.                                       |
| `src/openapi/`    | internal                | Shared spec model: reading, writing, normalising, and diffing OpenAPI documents.               |
| `src/typescript/` | internal                | TypeScript compiler API wrapper: type extraction in one direction, code emission in the other. |
| `bin/port.ts`     | `api-port`              | `api/` → `openapi.json` + `api.types.ts`.                                                      |
| `bin/backport.ts` | `api-backport`          | `openapi.json` → `api/` + `api.types.ts`.                                                      |

Both CLIs are thin argument parsers. All logic lives in `src/openapi/` and `src/typescript/`
so the two directions share one spec model and cannot drift apart.

### Data Flow

```text
                    ┌──────────────────────┐
                    │ src/typescript/      │
   api/  ──────────▶│ extract types        │──────┐
   (route modules)  └──────────────────────┘      │
                                                  ▼
                                        ┌────────────────────┐
                                        │ src/openapi/       │
                                        │ spec model         │
                                        └────────────────────┘
                                                  │
                    ┌──────────────────────┐      │
   api/  ◀──────────│ src/typescript/      │◀─────┤
   api.types.ts ◀───│ emit code            │      │
                    └──────────────────────┘      ▼
                                             openapi.json
                                                  │
                                                  ▼
                                    src/server (runtime validation)
```

### Design Rules

#### 1. No runtime dependencies

The server runs on `node:http`. The client runs on the global `fetch`. Argument parsing uses
`node:util.parseArgs`. The router, the JSON Schema validator, and the OpenAPI emitter are all
part of this package.

What that costs, stated plainly: the validator implements the JSON Schema subset that
[TYPE_MAPPING.md](./TYPE_MAPPING.md) documents and nothing more. A hand-written
`openapi.json` using a keyword outside that subset is a validation error, not a silent pass.
`typescript` is a development dependency, needed by the CLIs but never by the server or client
at runtime.

#### 2. TypeScript is the source of truth for shape; JSDoc for everything else

Route modules declare their contract as ordinary TypeScript types, and `api-port` reads them
with the TypeScript compiler API. This is the direction that loses information: `string`
cannot express `format: uuid`, `minLength: 3`, a description, or an `operationId`.

Two rules keep that loss from mattering:

- Anything TypeScript cannot express is carried by a JSDoc tag. The full vocabulary is in [TYPE_MAPPING.md](./TYPE_MAPPING.md).
- The supported type subset is closed. A construct outside it is a hard error that names the file, the line, and the type. The CLI never emits a degraded schema and hopes you notice.

`api-port --check` regenerates the spec and fails if it differs from the one on disk, so a
change to a route file that was never ported is caught in CI.

#### 3. Types vanish at runtime, so the spec is the runtime artifact

A route module's `Operation` interface exists only at compile time. Nothing derived from it
survives into the running process, which means the server cannot validate requests from the
types alone.

So it validates against the generated `openapi.json`:

```ts
createServer({ routes: './api', spec: './openapi.json', validate: true })
```

This is why the CLIs matter to the server itself and not only to consumers of the API. The
spec is not documentation that happens to be generated; it is the artifact that makes runtime
validation possible. Without `spec`, the server routes and serves but does not validate.

#### 4. One operation per file

An OpenAPI operation is identified by a path and a method. A route module is identified by a
directory and a filename. `api/users/[userId]/get.ts` is `get /users/{userId}` and nothing
else, in both directions, without a manifest to consult.

#### 5. The backport is stable

Running `api-backport` twice on the same spec produces byte-identical files. Running
`api-port` on the result reproduces the original spec. Neither CLI writes a timestamp, a
version banner, or a hash into its output.

### Implementation Prerequisites

The public specifiers and command names above require `package.json` fields that do not exist
yet and must be added when the packages are built:

```json
{
  "exports": {
    ".": "./src/main.ts",
    "./server": "./src/server/main.ts",
    "./client": "./src/client/main.ts"
  },
  "bin": {
    "api-port": "./bin/port.ts",
    "api-backport": "./bin/backport.ts"
  }
}
```

No build step is involved. Node executes the TypeScript sources directly, and `tsconfig.json`
sets `noEmit`.
