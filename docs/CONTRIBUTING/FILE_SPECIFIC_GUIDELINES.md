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

- `openapi.json` and `api.types.ts` are generated. Commit them, never hand-edit them.
- Review their diffs like any other diff — a surprising change there means a surprising change to the contract.

### TypeScript Files

- No runtime dependencies. `node:*` and web standards only; `typescript` is available to `bin/` and tooling, never to `src/server/` or `src/client/`.
- Public API changes require a documentation change in the same commit. Every exported symbol appears in exactly one document.

### Markdown Files

- Write in the present indicative. Document what the software does, not what it will do.
- Use relative links between documents, and link rather than repeat. No feature is described in two places.
- Prefer a table over a bulleted list for anything with a repeating shape: options, flags, type mappings, exit codes.
- Keep code blocks valid under the project's `tsconfig.json` and tag every block with its language.
- Put new documents in `docs/CONTRIBUTING/` and add them to the Contribution Handbook table in [CONTRIBUTING.md](../CONTRIBUTING.md). That table is the one index; do not start a second one.

### YAML Files

- Use consistent indentation (2 spaces) throughout the file.
- Include comments to explain non-obvious configurations.
- Validate the YAML syntax before committing.
- Follow the naming conventions for workflow and configuration files.
