# Agent Webhook Orchestrator

This app is the local/server entrypoint for GitHub webhook driven agent runs. It listens for GitHub issue and pull request comment events, validates commands and actor trust, builds a normalized worker job, and launches the disposable worker.

## Run Locally

Build both apps:

```bash
mise run orchestrator:build
mise run worker:build
```

Start the orchestrator with the local webhook defaults:

```bash
GITHUB_TOKEN="<BOT_ACCOUNT_PAT>" \
OPENROUTER_API_KEY="<YOUR_OPENROUTER_KEY>" \
mise run orchestrator:webhook
```

The `orchestrator:webhook` task sets the non-secret local defaults: host `0.0.0.0`, command prefix `webhook-agent`, Docker worker mode, OpenRouter planning, opencode implementation, SELinux Docker volume suffix `:Z`, webhook secret `local-secret`, and repository allowlist `Realrubr2/motomoto`.

Then trigger this local webhook path with `/webhook-agent plan`, `/webhook-agent approve`, or `/webhook-agent improve ...`. The custom prefix avoids conflicts when existing GitHub Actions already listen for `/agent` or `/opencode`.

Send the sample webhook:

```bash
body="$(cat apps/orchestrator/examples/issue-comment-plan.json)"
sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac local-secret -hex | awk '{print $2}')"

curl -i \
  -X POST http://127.0.0.1:8787/webhooks/github \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: issue_comment" \
  -H "X-Hub-Signature-256: $sig" \
  --data "$body"
```

## Launch Modes

- `ORCHESTRATOR_WORKER_LAUNCH_MODE=dry-run` logs the worker job without running Docker.
- `ORCHESTRATOR_WORKER_LAUNCH_MODE=process` runs `node apps/worker/dist/main.js` with `JOB_JSON`.
- `ORCHESTRATOR_WORKER_LAUNCH_MODE=docker` runs the configured worker image, defaulting to `agent-worker:local`.

Docker mode:

```bash
mise run worker:docker:build

GITHUB_TOKEN="<BOT_ACCOUNT_PAT>" \
OPENROUTER_API_KEY="<YOUR_OPENROUTER_KEY>" \
mise run orchestrator:webhook
```

## GitHub Configuration

For a real webhook receiver, set:

- `GITHUB_WEBHOOK_SECRET` to the webhook secret configured in GitHub.
- `GITHUB_TOKEN` or `GH_TOKEN` with permission to comment on issues and PRs.
- `ORCHESTRATOR_REPOSITORIES` to a comma-separated allowlist, for example `realrubr2/Server`.
- `ORCHESTRATOR_COMMAND_PREFIXES` to a comma-separated command allowlist, for example `webhook-agent`.
- `ORCHESTRATOR_DOCKER_VOLUME_SUFFIX` optional Docker volume suffix. Use `:Z` on SELinux systems if worker containers cannot write to `/data`.
- `AGENT_ALLOWED_ASSOCIATIONS`, default `OWNER,MEMBER,COLLABORATOR`.
- `ORCHESTRATOR_AGENT_MODE`, default `echo`.
- `ORCHESTRATOR_AGENT_MODEL`, default `local/echo`.

Provider credentials such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `OPENROUTER_API_KEY` are passed through to the worker when present.
