# API

## The `api/` Folder

An `api/` folder is a directory tree that mirrors your URL structure, with one file per HTTP
method. Both CLIs read and write this layout; see [CLI.md](./CLI.md).

```text
api/
├── schemas.ts              # shared types, become components/schemas
├── middleware.ts           # middleware applied to every route below api/
├── health/
│   └── get.ts              # get /health
└── users/
    ├── get.ts              # get /users
    ├── post.ts             # post /users
    ├── middleware.ts       # middleware applied to /users and below
    └── [userId]/
        ├── get.ts          # get /users/{userId}
        ├── patch.ts        # patch /users/{userId}
        └── delete.ts       # delete /users/{userId}
```

### Path Mapping

| Directory name | URL segment | Notes                                                        |
| -------------- | ----------- | ------------------------------------------------------------ |
| `users`        | `/users`    | A literal segment.                                           |
| `[userId]`     | `/{userId}` | A path parameter. Must be declared in `Operation.path`.      |
| `[...rest]`    | `/{rest}`   | A catch-all matching one or more segments. Typed `string[]`. |
| `(internal)`   | _(nothing)_ | A group. Organises files without adding a segment.           |

The folder root maps to `/`. A file at `api/get.ts` is `get /`.

### Method Files

The filename is the HTTP method in lowercase: `get.ts`, `post.ts`, `put.ts`, `patch.ts`,
`delete.ts`, `head.ts`, `options.ts`, `trace.ts`.

These filenames are reserved and are never treated as methods:

| Filename        | Purpose                                                                           |
| --------------- | --------------------------------------------------------------------------------- |
| `schemas.ts`    | Shared types. One per folder; the root one is conventional.                       |
| `middleware.ts` | Middleware for this folder and everything below it. See [SERVER.md](./SERVER.md). |
| `*.test.ts`     | Tests. Ignored by both CLIs.                                                      |
| `_*.ts`         | Any file starting with an underscore. Private helpers, ignored by both CLIs.      |

## Route Modules

A route module exports exactly one `Operation` interface and one `handler`. Nothing else is
read by the CLIs.

```ts
// api/users/[userId]/get.ts
import type { Handler } from '@plushveil/api/server'
import type { ApiError, User } from '../../schemas.ts'

/**
 * Fetch a single user by id.
 * @operationId getUser
 * @tags users
 */
export interface Operation {
  path: {
    /** @format uuid */
    userId: string
  }
  query: { include?: 'profile' | 'orders' }
  headers: { 'x-request-id'?: string }
  body: never
  responses: {
    200: User
    404: ApiError
  }
}

export const handler: Handler<Operation> = async (request) => {
  const user = await findUser(request.path.userId)
  if (!user) {
    return { status: 404, body: { code: 'not_found', message: 'No such user.' } }
  }
  return { status: 200, body: user }
}
```

### The `Operation` Interface

Every field is optional. Omit what the operation does not use.

| Field       | Type                           | Maps to                                                                                                                   |
| ----------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `path`      | object                         | `parameters` with `in: path`. Every key must correspond to a `[param]` directory, and all are required.                   |
| `query`     | object                         | `parameters` with `in: query`. Optional keys become `required: false`.                                                    |
| `headers`   | object                         | `parameters` with `in: header`. Key casing is preserved in the spec and matched case-insensitively at runtime.            |
| `cookies`   | object                         | `parameters` with `in: cookie`.                                                                                           |
| `body`      | any supported type, or `never` | `requestBody`. `never` or omitted means no body. Defaults to `application/json`; wrap in `Content` for other media types. |
| `responses` | `{ [status: number]: type }`   | `responses`. A bare type is `application/json`.                                                                           |

The JSDoc comment on `Operation` supplies operation metadata. The first line becomes
`summary`, subsequent prose becomes `description`, and tags supply the rest. The full tag list
is in [TYPE_MAPPING.md](./TYPE_MAPPING.md).

### Media Types

Use `Content` when a body or response is not JSON:

```ts
import type { Content, Handler } from '@plushveil/api/server'

export interface Operation {
  body: Content<'text/csv', string>
  responses: {
    200: Content<'application/pdf', Uint8Array>
    /** @description Nothing to export. */
    204: never
  }
}
```

A union of `Content` types declares several media types for one status:

```ts
responses: {
  200: Content<'application/json', User> | Content<'text/csv', string>
}
```

### The `handler` Export

```ts
export const handler: Handler<Operation> = async (request, context) => {
  /* … */
}
```

`request` is derived from `Operation`, so `request.path.userId` is `string`, `request.query.include`
is `'profile' | 'orders' | undefined`, and `request.body` is present only when the operation
declares one. `context` is the shared request context documented in [SERVER.md](./SERVER.md).

The return value must be assignable to one of the declared responses:

```ts
return {
  status: 200,
  body: user,
  headers: { 'cache-control': 'private, max-age=60' }, // optional
}
```

`status` must be a key of `Operation.responses`; returning an undeclared status is a type
error. `headers` is always optional and never type-checked against the spec. For a `never`
body, return `{ status: 204 }`.

To fail with a declared error status, either return it or throw `HttpError`:

```ts
import { HttpError } from '@plushveil/api/server'

throw new HttpError(404, { code: 'not_found', message: 'No such user.' })
```

## Shared Schemas

A **named** type used by an operation becomes an entry in `components/schemas`, referenced by
`$ref`. An **inline** type literal is emitted in place.

```ts
// api/schemas.ts

/** A registered user. */
export interface User {
  /** @format uuid */
  id: string
  /** @format email */
  email: string
  name: string
  /** @format date-time */
  createdAt: string
  role: 'admin' | 'member'
}

/** A failed request. */
export interface ApiError {
  code: string
  message: string
}
```

The component name is the type's declared name. Two different types with the same name in
different files is an error — rename one, or the round trip cannot be reversed.

`api-backport` writes every `components/schemas` entry to `api/schemas.ts` and imports from
there. Placing shared types anywhere else works when porting, but the backport will not
reproduce that layout.

## Route Modules Are Thin

Route modules declare a contract and adapt it to your application. Business logic belongs
outside `api/`, in `src/`, so that regenerating a route file never puts real logic at risk and
`api-backport --handlers keep` has a clean seam to preserve.
