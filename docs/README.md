# API

`@plushveil/api` keeps an OpenAPI specification and a real TypeScript implementation in sync,
in both directions.

Write route files in an `api/` folder and generate `openapi.json` from them. Or take an
`openapi.json` you were handed and generate the `api/` folder for it. Either way you get
`api.types.ts`, which the client package consumes to make every call type-safe.

The package has **no runtime dependencies**. It uses `node:http`, `node:fs`, `node:util`, and
the global `fetch`.

## The Surfaces

| Surface      | Import / command        | Purpose                                                        | Reference                             |
| ------------ | ----------------------- | -------------------------------------------------------------- | ------------------------------------- |
| Server       | `@plushveil/api/server` | Starts an HTTP server, exposes a router, registers middleware. | [SERVER.md](./CONTRIBUTING/SERVER.md) |
| Port CLI     | `api-port`              | Generates `openapi.json` from an `api/` folder.                | [CLI.md](./CONTRIBUTING/CLI.md)       |
| Backport CLI | `api-backport`          | Generates an `api/` folder from an `openapi.json`.             | [CLI.md](./CONTRIBUTING/CLI.md)       |
| Server CLI   | `api-server`            | Serves an `api/` folder over HTTP.                             | [CLI.md](./CONTRIBUTING/CLI.md)       |
| Client       | `@plushveil/api/client` | Consumes `api.types.ts` to call any API with full type safety. | [CLIENT.md](./CONTRIBUTING/CLIENT.md) |

```text
          api/  (TypeScript route modules)
           │                            ▲
  api-port │                            │ api-backport
           ▼                            │
       openapi.json ────────────────────┘
           │
           └─ api.types.ts ──▶ @plushveil/api/client
```

## Installation

```bash
npm install @plushveil/api
```

## Quick Start

### Existing spec, no code yet

Generate the implementation folder from a specification:

```bash
npx api-backport ./openapi.json --out ./api
```

This writes one file per operation (`api/users/[userId]/get.ts`), the shared schemas
(`api/schemas.ts`), and `api.types.ts`. Every generated handler throws `501 Not Implemented`
until you fill it in.

Then serve it, either from the command line:

```bash
npx api-server ./api --port 3000 --spec ./openapi.json --validate
```

or from your own process, which is the same code with your wiring around it:

```ts
import { createServer } from '@plushveil/api/server'

const server = createServer({ routes: './api', spec: './openapi.json', validate: true })
await server.listen(3000)
```

### Existing code, no spec yet

Write a route file:

```ts
// api/health/get.ts
import type { Handler } from '@plushveil/api/server'

/** Report service health. */
export interface Operation {
  responses: {
    200: { status: 'ok' }
  }
}

export const handler: Handler<Operation> = async () => {
  return { status: 200, body: { status: 'ok' } }
}
```

Generate the specification from it:

```bash
npx api-port ./api --out ./openapi.json
```

### Consuming an API

```ts
import { createClient } from '@plushveil/api/client'
import type { Api } from './api.types.ts'

const client = createClient<Api>({ baseUrl: 'https://api.example.com' })

const result = await client.get('/users/{userId}', {
  path: { userId: '3f2a9c1e-0000-4a7b-8c11-b6d2e4f50a91' },
})

if (result.status === 200) {
  console.log(result.body.email) // string
}
```

## Documentation

Start with [ARCHITECTURE.md](./CONTRIBUTING/ARCHITECTURE.md) for how the pieces fit together,
or [API_FOLDER.md](./CONTRIBUTING/API_FOLDER.md) for the `api/` folder convention.
[RELEASE.md](./RELEASE.md) covers tagging, publishing, and the container image. Every document is
listed in the [Contribution Handbook](./CONTRIBUTING.md#contribution-handbook).

## Contributing

Thank you for your interest in contributing! We welcome any contributions.
Please follow the guidelines in [CONTRIBUTING.md](CONTRIBUTING.md) for information on how to contribute.

## License

This project is licensed under the proprietary license of the organization. Please refer to the [LICENSE](../LICENSE) file for more details.
