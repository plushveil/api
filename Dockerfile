# syntax=docker/dockerfile:1

# Serves a mounted `api/` folder with `api-server`.
#
# No application code is baked in. Mount the folder you want served at /api:
#
#   docker run --rm -p 3000:3000 -v "$PWD/api:/api:ro" ghcr.io/plushveil/api
#
# There is no build step and no install step. Node executes the TypeScript sources directly through
# type stripping, and `api-server` reaches for nothing outside `node:*` — which is the whole point of
# the zero-dependency rule in docs/CONTRIBUTING/ARCHITECTURE.md. The runtime is pinned because type
# stripping is only stable from Node 22.18 and 24 onwards.
ARG NODE_VERSION=24-alpine

FROM node:${NODE_VERSION}

# The package lives outside node_modules, deliberately.
#
# Node refuses to strip types from any file whose real path is under node_modules
# (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), and this package ships TypeScript sources. So the
# sources go in /opt and node_modules gets a symlink to them: a bare specifier still resolves through
# node_modules, but Node resolves the symlink before loading, so the file it actually reads is under
# /opt and stripping is permitted.
WORKDIR /opt/plushveil-api

# `exports` lives here, and it is what makes `@plushveil/api/server` resolvable.
COPY package.json ./
COPY src ./src
COPY bin ./bin

# A mounted route module imports `@plushveil/api/server`, exactly as the documentation shows. Node
# resolves a bare specifier by walking up from the importing file, so a module at /api/health/get.ts
# looks in /api/node_modules and then /node_modules. Linking it at the filesystem root is what makes
# the documented import work at any mount depth, without the mounted folder carrying its own copy.
RUN mkdir -p /node_modules/@plushveil \
  && ln -s /opt/plushveil-api /node_modules/@plushveil/api

# Serving a read-only mount must never need write access.
USER node

# There is deliberately no VOLUME for /api. Declaring one would make Docker create an empty
# anonymous volume, so a container started without a mount would find an empty directory and serve
# nothing. Leaving it undeclared means the path simply does not exist, and `api-server` says so.

# `api-server` reads both. Binding to loopback inside a container would make the port unreachable
# from outside it, so the default is every interface.
ENV NODE_ENV=production \
  PORT=3000 \
  HOST=0.0.0.0

EXPOSE 3000

# Exec form, and `node` directly rather than through npm, so the server is PID 1 and receives
# SIGTERM itself. It installs its signal handlers before binding, so a `docker stop` is graceful
# rather than a ten-second timeout followed by SIGKILL.
ENTRYPOINT ["node", "/opt/plushveil-api/bin/server.ts"]
CMD ["/api"]
