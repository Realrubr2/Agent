# Agent Worker Container

This is the first scaffold for the disposable opencode worker container. It accepts job metadata, echoes the prompt, and persists session/job/transcript state to a local file store.

Run locally:

```bash
mise run worker:dev
```

Run tests:

```bash
mise run worker:test
```

Run opencode-specific tests:

```bash
mise run worker:test:opencode
```

Build the container:

```bash
mise run worker:docker:build
```

Run the container smoke suite:

```bash
mise run worker:test:opencode-container
```

Run the container with mounted persistence:

```bash
docker run --rm \
  -e JOB_FILE=/input/job.json \
  -e AGENT_STORE_DIR=/data \
  -v "$PWD/apps/worker/examples:/input" \
  -v "$PWD/.tmp/agent-store:/data" \
  agent-worker:local
```

The local store treats `sessionId` as the continuation key. Starting a new process or container with the same `sessionId` appends another attempt and transcript entries.

Run the no-provider opencode server check inside the container:

```bash
docker run --rm \
  -e JOB_FILE=/input/job-opencode-server-check.json \
  -e AGENT_STORE_DIR=/data \
  -v "$PWD/apps/worker/examples:/input" \
  -v "$PWD/.tmp/agent-store:/data" \
  agent-worker:local
```
