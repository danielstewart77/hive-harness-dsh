# The built dsh tree for a hive mind container.
#
# A mind does not install dsh: it bind-mounts a built working copy of this
# repository read-only at /opt/dsh and runs /opt/dsh/apps/cli/lib/bin.js. This
# file builds that copy on the mind image's own base (Ubuntu 24.04, NodeSource
# Node 22), because sharp, node-pty and koffi are native modules and must be
# compiled against the libc and architecture they will be loaded by. A tree
# built on a host with another glibc fails in the mind at its first dlopen.
#
# Built at /opt/dsh so every path recorded during install and build is the
# path the mind sees.
#
# Copy the built tree to a host folder (BuildKit's local exporter writes the
# files as the user running the command):
#
#   docker build --target tree --output type=local,dest="$HIVE_HOME/dsh" .
#
# A host web proxy reaches the build as the predefined HTTP_PROXY, HTTPS_PROXY
# and NO_PROXY build args.

FROM ubuntu:24.04 AS build

# python3, make and g++ are node-gyp's: node-pty compiles from source.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg git python3 make g++ \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
       | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
       > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/dsh

# The pnpm the repository pins in packageManager, read from the manifest so
# the two cannot drift. Installed with npm, not corepack: pnpm's pre-run
# dependency check shells out to a `pnpm` on PATH, which corepack does not put
# there.
COPY package.json ./
RUN npm install -g "$(node -p 'require("./package.json").packageManager')"

COPY . .
RUN pnpm install --frozen-lockfile

# Both compiler faces: dsh-base mounts dsh-api-gateway, whose lib/index.js the
# client face emits. The web frontend is not built: no hive profile mounts it.
RUN ./node_modules/.bin/tsc -b tsconfig.host.json \
    && ./node_modules/.bin/tsdown --env.DSH_BUILD_FACE host \
    && ./node_modules/.bin/tsc -b tsconfig.client.json \
    && ./node_modules/.bin/tsdown --env.DSH_BUILD_FACE client \
    && test -f apps/cli/lib/bin.js \
    && test -f hive/dsh-headless-resumable/lib/types/index.js \
    && test -f packages/session/session-persistence-jsonl/lib/read-log-cli.js

# The tree alone, for `--output type=local`.
FROM scratch AS tree
COPY --from=build /opt/dsh /
