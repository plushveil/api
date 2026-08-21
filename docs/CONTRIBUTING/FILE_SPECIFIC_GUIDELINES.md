# api

## File-Specific Guidelines

### Route Files

Files under `api/`. The convention is documented in [API_FOLDER.md](./API_FOLDER.md).

- Export exactly one `Operation` interface and one `handler`. Both CLIs read these two names and nothing else.
- Keep route files thin. Business logic belongs in `src/`, so that regenerating a route file never risks real logic and `api-backport --handlers keep` has a clean seam.
- Express constraints with JSDoc tags from [TYPE_MAPPING.md](./TYPE_MAPPING.md), not with inline comments. A tag ends up in the specification; a comment does not.
- Put shared types in `api/schemas.ts` and import them. Named types become `components/schemas`; inline literals do not.
- Stay inside the supported type subset. If you need something outside it, extend the mapping and document it rather than working around it in one file.
- Regenerate the specification in the same commit as the route change. `npx api-port ./api --check` fails otherwise.

### Generated Files

- `openapi.json`, `api.types.ts`, and `api/schemas.ts` are generated. Commit them, never hand-edit them.
- `api/schemas.ts` is rewritten by `api-backport` on every run and is not protected by `--force`, unlike route modules.
- Review their diffs like any other diff — a surprising change there means a surprising change to the contract.
- Regenerate with default flags. The committed artefacts must be exactly what `npx api-port ./api` produces, or the `--check` guard cannot pass.

### Generated Output Is Already Formatted

Nothing is exempt from `oxfmt` or `oxlint`, including generated files. Both CLIs emit output that
is already a fixed point of this project's own formatter, and a test asserts it:
`oxfmt --check` and `oxlint` are run over a freshly backported folder in
`test/suites/port.test.ts`.

Two consequences for anyone changing the emitters:

- The writer in `src/openapi/json.ts` mirrors the formatter's JSON style — objects always expand, an array of scalars collapses onto one line when it fits inside `printWidth`. Changing `printWidth` in `oxfmt.config.ts` means changing `PRINT_WIDTH` there too.
- The emitter in `src/typescript/emit.ts` only ever writes multi-line JSDoc, and puts a description in prose rather than in an `@description` tag, because those are the forms the formatter leaves alone. The formatter otherwise rewrites tag content — it capitalises descriptions, converts `@description` into prose, and reflows `@example` — and JSDoc is the channel that carries OpenAPI metadata (see [TYPE_MAPPING.md](./TYPE_MAPPING.md)), so an unstable form would corrupt the specification on the next `npm run lint`.

### TypeScript Files

- No runtime dependencies. `node:*` and web standards only; `typescript` is an optional peer available to `bin/` and `src/typescript/`, never to `src/server/` or `src/client/`.
- Import with `.ts` specifiers. The build rewrites them to `.js`, so a `.js` specifier in source would survive into the output and resolve to nothing.
- Public API changes require a documentation change in the same commit. Every exported symbol appears in exactly one document.

### The Build

- `dist/` is generated. Never edit it, never commit it, never import from it inside the repository — use `src/` directly.
- `npm run build` compiles `src/` and `bin/`. `prepack` runs it before packing, and `pretest` runs it because `exports` points into `dist/` and the fixture imports `@plushveil/api/server`.
- Anything added to the published surface belongs in `tsconfig.build.json`'s `include` and, if it is a new entry point, in `exports`.
- A change to what ships must keep [`test/suites/package.test.ts`](../../test/suites/package.test.ts) passing. It installs a real tarball, which is the only check that covers the path a consumer takes.

### Markdown Files

- Write in the present indicative. Document what the software does, not what it will do.
- Use relative links between documents, and link rather than repeat. No feature is described in two places.
- Prefer a table over a bulleted list for anything with a repeating shape: options, flags, type mappings, exit codes.
- Keep code blocks valid under the project's `tsconfig.json` and tag every block with its language.
- Put contributor guidance in `docs/CONTRIBUTING/`. A document that is not guidance — something a consumer or an operator reads, like [RELEASE.md](../RELEASE.md) — belongs at the `docs/` root instead.
- Either way, add it to the Contribution Handbook table in [CONTRIBUTING.md](../CONTRIBUTING.md). That table is the one index; do not start a second one.

### YAML Files

- Use consistent indentation (2 spaces) throughout the file.
- Include comments to explain non-obvious configurations.
- Validate the YAML syntax before committing.
- Follow the naming conventions for workflow and configuration files.
