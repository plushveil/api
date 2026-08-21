# syntax=docker/dockerfile:1

# Serves a mounted `api/` folder with `api-server`.
#
# No application code is baked in. Mount the folder you want served at /api:
#
#   docker run --rm -p 3000:3000 -v "$PWD/api:/api:ro" ghcr.io/plushveil/api
#
# Node is pinned because the *mounted* folder is TypeScript: the route modules you mount are stripped
# at load time, and stripping is only stable from Node 22.18 and 24 onwards. The package itself is
# compiled, so it imposes no such requirement.
ARG NODE_VERSION=24-alpine

# --- build ------------------------------------------------------------------------------------
# The compiler is a development dependency, so it stays in this stage and never reaches the image.
FROM node:${NODE_VERSION} AS build

WORKDIR /build
COPY package.json ./
RUN npm install --no-audit --no-fund --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY bin ./bin

# Same command `prepack` runs, so the image and the npm tarball are built from one definition.
RUN npm run build

# --- runtime ----------------------------------------------------------------------------------
FROM node:${NODE_VERSION}

# Installed as an ordinary package under node_modules.
#
# This is only possible because the package is compiled. Shipping TypeScript here would fail:
# Node refuses to strip types from any file whose real path is under node_modules
# (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). A mounted route module at /api/health/get.ts is
# outside node_modules, so it is still stripped normally, and its
# `import … from '@plushveil/api/server'` resolves by walking up to /node_modules.
WORKDIR /node_modules/@plushveil/api
COPY --from=build /build/package.json ./
COPY --from=build /build/dist ./dist

# `bin` entries are relative to the package, so the commands are linked by hand rather than by npm.
RUN ln -s /node_modules/@plushveil/api/dist/bin/server.js /usr/local/bin/api-server \
  && ln -s /node_modules/@plushveil/api/dist/bin/port.js /usr/local/bin/api-port \
  && ln -s /node_modules/@plushveil/api/dist/bin/backport.js /usr/local/bin/api-backport

# Serving a read-only mount must never need write access.
USER node

# There is deliberately no VOLUME for /api. Declaring one would make Docker create an empty
# anonymous volume, so a container started without a mount would find an empty directory and serve
# nothing. Leaving it undeclared means the path does not exist, and `api-server` says so.

# `api-server` reads both. Binding to loopback inside a container would make the port unreachable
# from outside it, so the default is every interface.
ENV NODE_ENV=production \
  PORT=3000 \
  HOST=0.0.0.0

EXPOSE 3000

# Exec form, and `node` directly rather than through npm, so the server is PID 1 and receives
# SIGTERM itself. It installs its signal handlers before binding, so a `docker stop` is graceful
# rather than a ten-second timeout followed by SIGKILL.
#
# `api-port` and `api-backport` are on PATH too, but porting needs the `typescript` peer, which this
# image does not carry. Porting is a development-time activity.
ENTRYPOINT ["node", "/node_modules/@plushveil/api/dist/bin/server.js"]
CMD ["/api"]
