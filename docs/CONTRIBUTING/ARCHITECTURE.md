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
| `src/schema/`     | internal                | Dependency-free JSON Schema subset validator and parameter coercion.                           |
| `src/typescript/` | internal                | TypeScript compiler API wrapper: type extraction in one direction, code emission in the other. |
| `bin/port.ts`     | `api-port`              | `api/` → `openapi.json` + `api.types.ts`.                                                      |
| `bin/backport.ts` | `api-backport`          | `openapi.json` → `api/` + `api.types.ts`.                                                      |
| `bin/server.ts`   | `api-server`            | Serves an `api/` folder over HTTP.                                                             |
| `bin/lib/`        | internal                | Argument parsing, config loading, help text, and exit codes shared by every command.           |

Every command is a thin argument parser. All logic lives in `src/openapi/`, `src/typescript/`,
and `src/server/`, so the two directions share one spec model and cannot drift apart. `bin/lib/`
holds only the plumbing that is inherently about being a command — parsing `argv`, rendering
`--help`, choosing an exit code — and nothing about specifications or TypeScript.

`api-server` exists because a route module is not runnable on its own: it declares a contract and
exports a handler, and something has to load the folder and bind a socket. It is the same
`createServer` a consumer would call, with a command line in front of it.

`src/schema/` is separate from `src/openapi/` because it is the one piece both the server and the
CLIs need. The server validates requests with it at runtime and must not pull in the spec reader
or `typescript` to do so; the CLIs use it to check a document they were handed.

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

`typescript` is an **optional peer dependency**. The server and the client never touch it; `api-port`
and `api-backport` do, and they load it dynamically so a consumer who installed only the runtime gets
a sentence telling them what to install rather than a module-resolution crash. Anyone writing route
modules already has a compiler, so in practice it is already there.

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

#### 6. Development runs from source; consumers get a build

Locally there is no build: `node bin/port.ts` runs the sources directly through Node's type
stripping, and `tsconfig.json` sets `noEmit` so type-checking never emits anything.

Publishing is different, and it has to be. Node refuses to strip types from any file whose real path
is under `node_modules`, so a package of `.ts` files is unusable the moment it is installed. So
`npm pack` and `npm publish` run `prepack`, which compiles `src/` and `bin/` to `dist/` with
declarations, and `exports` points there.

|          | Development         | Consumer                     |
| -------- | ------------------- | ---------------------------- |
| Entry    | `src/**/*.ts`       | `dist/src/**/*.js` + `.d.ts` |
| Run with | Node type stripping | Plain Node                   |
| Built by | nothing             | `prepack`                    |

Two consequences worth knowing:

- Imports are written with `.ts` specifiers, which normally forbids emit. `rewriteRelativeImportExtensions` rewrites them to `.js` in the output, so the published package needs no loader.
- `exports` points into `dist/`, so the fixture's `@plushveil/api/server` import resolves there too. That is why `pretest` builds: without it, type-checking the repository would fail on its own fixture.

### Resolution

The public specifiers and command names above come from `package.json`:

```json
{
  "exports": {
    ".": { "types": "./dist/src/main.d.ts", "default": "./dist/src/main.js" },
    "./server": { "types": "./dist/src/server/main.d.ts", "default": "./dist/src/server/main.js" },
    "./client": { "types": "./dist/src/client/main.d.ts", "default": "./dist/src/client/main.js" }
  },
  "bin": {
    "api-backport": "./dist/bin/backport.js",
    "api-port": "./dist/bin/port.js",
    "api-server": "./dist/bin/server.js"
  },
  "files": ["dist"]
}
```

Generated route modules import `@plushveil/api/server` rather than a relative path into `src/`,
which is what a consumer writes. Node resolves a package's own name from inside it through the same
`exports` map, so the emitted code compiles and runs both in this repository and in one that
installed it.

`test/suites/package.test.ts` is what keeps this honest: it packs a tarball, installs it into a
throwaway project, and serves a request from there. No other test can, because inside this
repository the specifier self-references the repository root and never touches `node_modules` — the
one code path a consumer never takes.
