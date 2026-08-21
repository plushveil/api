# API

## Releasing

A release is a tag. Everything downstream — the npm package, the GitHub Packages copy, and the
container image — is produced from it by CI.

## Cutting one

Run the **Release** workflow from the Actions tab, or from the command line:

```bash
gh workflow run release.yml -f tag=v1.2.3
gh workflow run release.yml -f tag=v1.2.3 -f source=some-branch
```

`source` defaults to the default branch. `tag` must be a full semantic version — `v1.2.3`, never
`v1.2` — because the shorter tags are derived from it rather than given.

That workflow runs [`release.sh`](../.github/scripts/release.sh), which moves three tags to the same
commit:

| Tag      | Moved when                      |
| -------- | ------------------------------- |
| `v1.2.3` | Always.                         |
| `v1.2`   | Unless `v1.2.4` already exists. |
| `v1`     | Unless `v1.3` already exists.   |

The conditions are what keep a backport from dragging a moving tag backwards: releasing `v1.2.3`
after `v1.3.0` shipped updates the patch tag and leaves `v1` pointing at the newer line.

Each moved tag then dispatches **CD**.

## What CD publishes

[`publish.yml`](../.github/workflows/publish.yml) runs on a `v*` tag push and on dispatch from
`release.sh`. Both paths resolve to one `RELEASE_TAG`, because `github.ref_name` is the tag for a
push but the _branch_ for a dispatch and cannot be used on its own.

Three jobs, with the two publishing jobs gated on the first:

1. **build** — installs and runs `npm test` against the tagged commit, on the Node version in `.nvmrc`. Nothing publishes if this fails.
2. **publish-package** — sets the version from the tag, then publishes to npm and to GitHub Packages. Each registry gets its own `setup-node` step, because the second rewrites `.npmrc`; without that the second publish would target npm again and fail with a 409.
3. **publish-image** — builds `Dockerfile` for `linux/amd64` and `linux/arm64` and pushes it to `ghcr.io/<owner>/<repo>`, tagged with the version, the tag, and `latest`. It then pulls the pushed image back and serves the repository's own fixture through it, because an image that cannot answer a request is worse than no image.

The image name is derived from `GITHUB_REPOSITORY`, so a fork or a rename cannot publish into
someone else's package.

### Secrets

| Secret         | Used for                                             |
| -------------- | ---------------------------------------------------- |
| `NPM_TOKEN`    | Publishing to npm.                                   |
| `GITHUB_TOKEN` | GitHub Packages, GHCR, and dispatching CD. Built in. |

## The container image

```bash
docker run --rm -p 3000:3000 -v "$PWD/api:/api:ro" ghcr.io/plushveil/api
```

The image carries this package and no application code. Mount the folder to serve at `/api`; it can
be read-only, because nothing in the serving path writes. `PORT` and `HOST` are read from the
environment, defaulting to `3000` and `0.0.0.0` — loopback would make the published port
unreachable from outside the container.

It runs `api-server` and only `api-server`. `api-port` and `api-backport` need `typescript`, which is
a development dependency, so porting is a development-time activity and not part of this image.

Two implementation details worth knowing before changing the `Dockerfile`:

- **The package lives in `/opt`, not `node_modules`.** Node refuses to strip types from any file whose real path is under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), and this package ships TypeScript. `/node_modules/@plushveil/api` is a symlink to `/opt/plushveil-api`, so a mounted route module's `import … from '@plushveil/api/server'` still resolves, while the file Node actually loads sits outside `node_modules`.
- **There is no `VOLUME` for `/api`.** Declaring one would make Docker create an empty anonymous volume, so a container started without a mount would find an empty directory and serve nothing. Leaving it out means the path does not exist and `api-server` exits `1` saying so.

## A consumer cannot `npm install` this package and run it as-is

This is the one thing to understand before publishing.

The package ships TypeScript sources with no build step: `exports` points at `.ts` files and
`tsconfig.json` sets `noEmit`. Node's type stripping refuses to run on anything under
`node_modules`, so a consumer who installs the package and imports
`@plushveil/api/server` gets:

```text
Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]:
Stripping types is currently unsupported for files under node_modules
```

The tests do not catch this, because inside this repository the specifier resolves to the repository
root through the `exports` self-reference and never touches `node_modules`.

Until it is resolved, the npm artefact is usable by anything that compiles or bundles the sources
itself — and the container image works, because it sidesteps `node_modules` by construction. The
options, none of which has been chosen yet:

| Option                                                                       | Cost                                                                                                                                      |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Add a build step emitting `.js` + `.d.ts`, and point `exports` at the output | Contradicts the no-build-step rule in [ARCHITECTURE.md](./CONTRIBUTING/ARCHITECTURE.md); needs a `files` allowlist and a `prepack` script |
| Publish sources and document that consumers must bundle                      | Rules out plain `node` consumers, which is most of them                                                                                   |
| Ship the image as the primary artefact and treat npm as source distribution  | Honest, but narrows the client package's usefulness, since a browser client has to be bundled anyway                                      |

## Checklist before tagging

- `npm test` is green on the commit being released.
- `docker build .` succeeds, and the image serves the fixture.
- Generated artefacts under `test/fixtures/` are current: `api-port … --check` exits `0`.
- Documentation matches behaviour — see the same-commit rule in [FILE_SPECIFIC_GUIDELINES.md](./CONTRIBUTING/FILE_SPECIFIC_GUIDELINES.md).
