# Factory runner image: one image a CI job can run the itsaplan runner from, with the
# coding agent CLI it is most likely to need already installed and pinned.
#
# Build from the repository root (the runner package is the context, not the repo):
#   docker build -f images/factory-runner/Dockerfile -t factory-runner:sf10 packages/runner
#
# Where docker.io is unreachable, pull the base images through a mirror and retag:
#   docker pull docker.m.daocloud.io/library/node:22-bookworm-slim
#   docker tag  docker.m.daocloud.io/library/node:22-bookworm-slim node:22-bookworm-slim
#
# No secret belongs in this image: the runner reads ITSAPLAN_URL and ITSAPLAN_API_KEY
# from its environment, and the coding agent its own (ANTHROPIC_*).

# The runner package has no runtime dependencies — its source is the whole build input.
FROM oven/bun:1.4.2 AS build
WORKDIR /src
COPY src ./src
RUN bun build src/cli.ts --target=node --outfile dist/cli.js

FROM node:22-bookworm-slim

# bun for anything else a factory job runs; the coding agent pinned so a rebuild this
# year and a rebuild next year run the same agent. The npm registry mirror is the
# reachable one from this network; drop --registry where npmjs.org answers.
ARG CLAUDE_CODE_VERSION=2.1.286
RUN npm install -g --registry=https://registry.npmmirror.com \
      bun@1.4.2 \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

COPY --from=build /src/dist/cli.js /usr/local/lib/itsaplan-runner/cli.js
RUN printf '#!/bin/sh\nexec node /usr/local/lib/itsaplan-runner/cli.js "$@"\n' \
      > /usr/local/bin/itsaplan-runner \
    && chmod +x /usr/local/bin/itsaplan-runner

# No ENTRYPOINT on purpose: a CI executor passes its own command (GitLab runs the job
# script through `sh -c`), which an entrypoint would swallow. The job script names
# `itsaplan-runner --once` itself.
