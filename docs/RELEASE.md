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

- **It is a two-stage build.** The first stage installs the compiler and runs `npm run build`; the second copies only `package.json` and `dist/`, so no compiler reaches the image. The package sits at `/node_modules/@plushveil/api` as an ordinary install, which is only possible because it is compiled — shipping `.ts` there would hit the `node_modules` stripping ban. A mounted route module is outside `node_modules`, so it is still stripped normally, which is why the image pins Node.
- **There is no `VOLUME` for `/api`.** Declaring one would make Docker create an empty anonymous volume, so a container started without a mount would find an empty directory and serve nothing. Leaving it out means the path does not exist and `api-server` exits `1` saying so.

## The build

The published package is compiled. It has to be: Node refuses to strip types from any file whose real
path is under `node_modules`, so a package of `.ts` files fails on `import` the moment it is
installed:

```text
Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]:
Stripping types is currently unsupported for files under node_modules
```

`npm run build` compiles `src/` and `bin/` to `dist/` with declarations and source maps, using
[`tsconfig.build.json`](../tsconfig.build.json). `prepack` runs it, so `npm pack` and `npm publish`
cannot ship a stale or missing build. `pretest` runs it too, because `exports` points into `dist/`
and the fixture imports `@plushveil/api/server`.

Imports are written with `.ts` specifiers, which normally forbids emit;
`rewriteRelativeImportExtensions` rewrites them to `.js` in the output, so the published package
needs no loader.

### What consumers get

```bash
npm install @plushveil/api
```

```ts
import { createServer } from '@plushveil/api/server'
import { createClient } from '@plushveil/api/client'
```

Plain Node, no loader, no bundler, and full types. Node 22 or newer, per `engines`.

`api-port` and `api-backport` additionally need `typescript`, declared as an **optional** peer
dependency: serving and consuming an API never need a compiler, and porting cannot work without one.
A consumer who skipped it gets a sentence naming what to install rather than a resolution crash.

Route modules a consumer writes are their own files, outside `node_modules`, so Node strips them
normally — which needs Node 22.18 or 24 and later.

### Why this cannot silently regress

[`test/suites/package.test.ts`](../test/suites/package.test.ts) packs a real tarball, installs it
into a throwaway project, and from there: imports both entry points, serves a request, runs all three
commands, ports a folder, and type-checks a consumer file whose `tsconfig.json` deliberately lacks
`allowImportingTsExtensions`. It also asserts the tarball contains `dist/` and nothing else.

No other test can cover this. Inside the repository, `@plushveil/api/server` resolves through the
`exports` self-reference to the repository root and never touches `node_modules` — the one path a
consumer never takes, and the reason the problem went unnoticed until an install was actually tried.

## Checklist before tagging

- `npm test` is green on the commit being released. It builds first, and it includes the packaged-consumer suite.
- `npm pack --dry-run` lists `dist/` and nothing else.
- `docker build .` succeeds, and the image serves the fixture.
- Generated artefacts under `test/fixtures/` are current: `api-port … --check` exits `0`.
- Documentation matches behaviour — see the same-commit rule in [FILE_SPECIFIC_GUIDELINES.md](./CONTRIBUTING/FILE_SPECIFIC_GUIDELINES.md).
