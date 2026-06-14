FROM node:20-bookworm-slim AS build

WORKDIR /app
COPY package.json ./
COPY apps/worker ./apps/worker
RUN node apps/worker/scripts/build.mjs

FROM node:20-bookworm-slim

ARG OPENCODE_VERSION=1.15.10
ARG OPENCODE_LANGFUSE_PLUGIN_VERSION=0.1.8

WORKDIR /app
COPY package.json ./

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g "opencode-ai@${OPENCODE_VERSION}" "opencode-plugin-langfuse@${OPENCODE_LANGFUSE_PLUGIN_VERSION}" \
  && npm install --omit=dev \
  && opencode --version

ENV NODE_ENV=production
ENV AGENT_STORE_DIR=/data
ENV HOME=/tmp/agent-worker-home
ENV XDG_DATA_HOME=/tmp/agent-worker-data
ENV XDG_CONFIG_HOME=/tmp/agent-worker-config
ENV NO_PROXY=127.0.0.1,localhost

COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/examples ./apps/worker/examples

CMD ["node", "apps/worker/dist/main.js"]
