# api

## Folder Structure

```text
├── .devcontainer/     # Development container configuration
├── .vscode/           # VS Code workspace settings
├── bin/               # Command line entry points
│   ├── port.ts        # api-port: api/ -> openapi.json
│   ├── backport.ts    # api-backport: openapi.json -> api/
│   ├── server.ts      # api-server: serves an api/ folder over HTTP
│   └── lib/           # Argument parsing, config loading, help text, exit codes
├── Dockerfile         # Image that serves a mounted api/ folder with api-server
├── docs/              # Project documentation
│   └── CONTRIBUTING/  # Contribution guidelines and package references
├── src/               # Source code
│   ├── client/        # @plushveil/api/client: type-safe API consumer
│   ├── openapi/       # Shared OpenAPI document model, used by both CLIs
│   ├── schema/        # JSON Schema subset validator, used by the server and both CLIs
│   ├── server/        # @plushveil/api/server: HTTP server, router, middleware
│   └── typescript/    # TypeScript compiler API: type extraction and code emission
└── test/              # Tests
    ├── fixtures/      # Complete api/ folders with their generated artefacts
    ├── helpers/       # Shared test utilities
    ├── suites/        # Executed by `npm run test:smoke`
    └── types/         # Compile-time assertions, checked by `npm run test:types`
```

This repository ships no `api/` folder of its own. The round-trip tests work against fixtures
under `test/fixtures/`, each a self-contained directory holding an `api/` folder together with
the `openapi.json` and `api.types.ts` generated from it — so a fixture is both the input and the
expected output of the round trip. `test/fixtures/api-health/` is the first of them.

The layout inside a fixture is the convention documented in
[API_FOLDER.md](./API_FOLDER.md); the packages it exercises are described in
[ARCHITECTURE.md](./ARCHITECTURE.md).
