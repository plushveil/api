# API

## Type Mapping

How TypeScript becomes OpenAPI 3.1, and back. This is the reference `api-port` and
`api-backport` both implement; see [CLI.md](./CLI.md).

OpenAPI 3.1 schemas are JSON Schema 2020-12, so there is no separate dialect to reconcile.

### Supported Types

| TypeScript                  | JSON Schema                                                    | Notes                                                               |
| --------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| `string`                    | `{ "type": "string" }`                                         |                                                                     |
| `number`                    | `{ "type": "number" }`                                         |                                                                     |
| `bigint`                    | `{ "type": "integer" }`                                        |                                                                     |
| `boolean`                   | `{ "type": "boolean" }`                                        |                                                                     |
| `null`                      | `{ "type": "null" }`                                           |                                                                     |
| `'a'`                       | `{ "const": "a" }`                                             | Any string, number, or boolean literal.                             |
| `'a' \| 'b'`                | `{ "type": "string", "enum": ["a", "b"] }`                     | A union of same-typed literals collapses to `enum`.                 |
| `A \| B`                    | `{ "oneOf": [...] }`                                           | A union of mixed types.                                             |
| `A & B`                     | `{ "allOf": [...] }`                                           |                                                                     |
| `T[]`                       | `{ "type": "array", "items": … }`                              |                                                                     |
| `[A, B]`                    | `{ "type": "array", "prefixItems": [...], "items": false }`    | A fixed tuple.                                                      |
| `[A, ...B[]]`               | `{ "type": "array", "prefixItems": [...], "items": … }`        | A variadic tuple.                                                   |
| `interface` / `type` object | `{ "type": "object", "properties": …, "required": [...] }`     | `additionalProperties: false` unless an index signature is present. |
| `prop?: T`                  | Omitted from `required`                                        |                                                                     |
| `readonly prop: T`          | `{ "readOnly": true }`                                         |                                                                     |
| `Record<string, T>`         | `{ "type": "object", "additionalProperties": … }`              | Also `{ [k: string]: T }`.                                          |
| `Record<'a' \| 'b', T>`     | `{ "properties": { "a": …, "b": … }, "required": ["a", "b"] }` | A finite key union expands.                                         |
| `unknown` / `any`           | `{}`                                                           |                                                                     |
| `never`                     | _(omitted)_                                                    | No request body, or an empty response.                              |
| `Date`                      | `{ "type": "string", "format": "date-time" }`                  | Serialised as an ISO 8601 string.                                   |
| `Uint8Array`                | `{ "type": "string", "format": "binary" }`                     |                                                                     |
| `T \| null`                 | `{ "type": [..., "null"] }`                                    |                                                                     |
| A named type                | `{ "$ref": "#/components/schemas/Name" }`                      | See [API_FOLDER.md](./API_FOLDER.md).                               |
| A recursive named type      | `$ref` back to itself                                          | Cycles are fine, because they become references.                    |

Mapped and conditional types (`Pick`, `Omit`, `Partial`, `Required`, `Exclude`, and your own)
are fully supported. They are resolved to their result before emission, so `Omit<User, 'id'>`
emits an inline object rather than a reference. Name the result if you want a component:

```ts
export interface PublicUser extends Omit<User, 'id'> {}
```

Generic types are resolved at each use site. `Page<User>` emits an inline object unless you
name the instantiation.

### Unsupported Types

These are hard errors naming the file, line, and type. Nothing is silently degraded.

| TypeScript                   | Error                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `symbol`, `undefined`        | `unrepresentable type` — JSON has no equivalent. Use `null` or an optional property.     |
| A function or method         | `unrepresentable type` — not serialisable.                                               |
| A class                      | `unrepresentable class` — use an interface describing the wire shape.                    |
| `object`                     | `ambiguous type` — use `Record<string, unknown>`.                                        |
| `enum`                       | `unsupported enum` — use a literal union. It has no OpenAPI equivalent that round-trips. |
| A template literal type      | `unsupported template literal` — use `string` with `@pattern`.                           |
| An unresolved type parameter | `unresolved generic` — a route module's types must be fully concrete.                    |

### JSDoc Tags

Everything OpenAPI needs that TypeScript cannot express. Tags are read from the JSDoc comment
attached to the declaration they modify.

The comment's first line becomes `summary` on an operation and `description` on a schema or
property. Prose after a blank line becomes `description` on an operation.

#### On `Operation`

| Tag             | Maps to            | Example                                                             |
| --------------- | ------------------ | ------------------------------------------------------------------- |
| `@operationId`  | `operationId`      | `@operationId getUser`                                              |
| `@summary`      | `summary`          | Overrides the first comment line.                                   |
| `@description`  | `description`      | Overrides the trailing prose.                                       |
| `@tags`         | `tags`             | `@tags users admin` — space-separated.                              |
| `@deprecated`   | `deprecated: true` | Any trailing text becomes part of the description.                  |
| `@security`     | `security`         | `@security bearerAuth` or `@security oauth2 read:users write:users` |
| `@externalDocs` | `externalDocs`     | `@externalDocs https://example.com Guide`                           |
| `@server`       | `servers`          | Repeatable. Overrides the document's servers for this operation.    |

#### On a response status

| Tag            | Maps to                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------- |
| `@description` | The response object's `description`. Defaults to the standard reason phrase for the status. |

#### On a schema, property, or parameter

| Tag                                       | Maps to                   | Applies to                                                |
| ----------------------------------------- | ------------------------- | --------------------------------------------------------- |
| `@format`                                 | `format`                  | `string`, `number`                                        |
| `@pattern`                                | `pattern`                 | `string`                                                  |
| `@minLength` / `@maxLength`               | `minLength` / `maxLength` | `string`                                                  |
| `@minimum` / `@maximum`                   | `minimum` / `maximum`     | `number`                                                  |
| `@exclusiveMinimum` / `@exclusiveMaximum` | same                      | `number`                                                  |
| `@multipleOf`                             | `multipleOf`              | `number`                                                  |
| `@minItems` / `@maxItems`                 | `minItems` / `maxItems`   | arrays                                                    |
| `@uniqueItems`                            | `uniqueItems: true`       | arrays                                                    |
| `@minProperties` / `@maxProperties`       | same                      | objects                                                   |
| `@default`                                | `default`                 | any — parsed as JSON                                      |
| `@example`                                | `example`                 | any — parsed as JSON, repeatable to produce `examples`    |
| `@title`                                  | `title`                   | any                                                       |
| `@deprecated`                             | `deprecated: true`        | any                                                       |
| `@readOnly` / `@writeOnly`                | `readOnly` / `writeOnly`  | any                                                       |
| `@contentMediaType`                       | `contentMediaType`        | `string`                                                  |
| `@style` / `@explode`                     | `style` / `explode`       | parameters only — controls array and object serialisation |

`@format` accepts any string. The values the runtime validator enforces are `date-time`,
`date`, `time`, `duration`, `email`, `hostname`, `ipv4`, `ipv6`, `uri`, `uri-reference`,
`uuid`, `int32`, `int64`, `float`, `double`, `byte`, `binary`, and `password`. Others are
emitted to the spec and carried through the backport, but not checked at runtime.

```ts
export interface CreateUser {
  /**
   * Contact address. Must be unique.
   * @format email
   * @maxLength 254
   * @example "ada@example.com"
   */
  email: string

  /**
   * @minimum 13
   * @maximum 120
   */
  age?: number
}
```

### Security Schemes

`@security` references a scheme by name. The schemes themselves live in the document
configuration rather than in a route module, because they are document-scoped:

```ts
// api.config.ts
export default {
  title: 'Users API',
  version: '1.0.0',
  securitySchemes: {
    bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
  },
}
```

See [CLI.md](./CLI.md) for the full configuration file.

### Backporting

Every row of the supported-types table is reversible, and `api-backport` picks the leftmost
TypeScript form that produces the given schema. Two cases need a rule:

- **Keywords with no TypeScript equivalent** (`minLength`, `format`, `description`, …) become JSDoc tags, which is exactly how they got there.
- **Keywords in neither table** (`if` / `then` / `else`, `dependentSchemas`, `not`, `patternProperties`, `unevaluatedProperties`) cannot be represented. The property is typed `unknown`, the original schema is preserved verbatim in a `@schema` tag so `api-port` can put it back, and the CLI warns. The round trip stays lossless even though the type is imprecise.
