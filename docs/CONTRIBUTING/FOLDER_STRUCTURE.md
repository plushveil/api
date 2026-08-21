# api

## Folder Structure

```text
├── .devcontainer/     # Development container configuration
├── .vscode/           # VS Code workspace settings
├── api/               # Route modules; the implementation side of the spec
├── bin/               # Command line entry points
│   ├── port.ts        # api-port: api/ -> openapi.json
│   └── backport.ts    # api-backport: openapi.json -> api/
├── docs/              # Project documentation
│   └── CONTRIBUTING/  # Contribution guidelines and package references
├── src/               # Source code
│   ├── client/        # @plushveil/api/client: type-safe API consumer
│   ├── openapi/       # Shared OpenAPI document model, used by both CLIs
│   ├── server/        # @plushveil/api/server: HTTP server, router, middleware
│   └── typescript/    # TypeScript compiler API: type extraction and code emission
└── test/              # Tests
```

The `api/` folder in this repository is the fixture the round-trip tests assert against. Its
layout is the convention documented in [API_FOLDER.md](./API_FOLDER.md); the packages it
exercises are described in [ARCHITECTURE.md](./ARCHITECTURE.md).
