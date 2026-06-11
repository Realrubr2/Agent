# Shared Agent GitHub Action

This directory is a portable scaffold for a shared Agent repo.

Target repos call reusable workflows from the shared repo and pass OpenRouter model names. The action runs OpenCode with OpenRouter, allowing it to edit files and run shell commands in the checked-out repository.

GitHub does not expose this Agent repo's secrets to workflow runs in other repositories. Without a GitHub organization, add provider and telemetry secrets to each caller repo, then keep `secrets: inherit` in the caller workflow.

## Caller workflow

```yaml
name: Agent

on:
  issues:
    types: [opened, edited]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  schedule:
    - cron: "0 9 * * 1"
  workflow_dispatch:

permissions:
  contents: write
  issues: write
  pull-requests: write

jobs:
  agent:
    uses: Realrubr2/Agent/.github/workflows/agent.yml@main
    with:
      model: openrouter/z-ai/glm-4.7-flash
      review_model: openrouter/z-ai/glm-4.7-flash
      schedule_model: openrouter/z-ai/glm-4.7-flash
      issues: true
      pull_requests: true
      scheduled: true
      provider_timeout_ms: "900000"
      schedule_prompt: |
        Review the repository for stale TODO comments and summarize anything that should become an issue or pull request.
    secrets: inherit
```

The event toggles decide which incoming events are allowed to run the single shared job:

- `issues`: issue opened/edited events and `/agent` issue comments.
- `pull_requests`: pull request events, `/agent` pull request comments, `/agent` review comments, and `/renovate` on pull request threads.
- `scheduled`: `schedule` and `workflow_dispatch` events.

GitHub requires cron schedules to be declared in the caller workflow under `on.schedule`; the `scheduled` input only controls whether the shared job runs when that event fires.

For example, to allow issues and scheduled runs but disable pull request runs:

```yaml
with:
  model: openrouter/z-ai/glm-4.7-flash
  issues: true
  pull_requests: false
  scheduled: true
  schedule_prompt: |
    Review the repository for maintenance tasks.
```

More copyable examples live in `examples/workflows`.

When OpenCode changes files, the action opens a helper pull request from an `agent/<issue>-<run>` branch. If no files changed, it only comments with the agent response.

OpenCode provider requests default to `provider_timeout_ms: "900000"` in this workflow, which is 15 minutes. If a model or dependency-update run needs more room, raise that value in the caller workflow.

The caller repo must allow workflows to create pull requests. In the caller repo, open `Settings -> Actions -> General -> Workflow permissions`, choose `Read and write permissions`, and enable `Allow GitHub Actions to create and approve pull requests`.

## Renovate PRs

Comment `/renovate` on a Renovate pull request to run the dependency-update flow. The action loads `renovate-skill` automatically, reads the PR body, changed files, issue comments, reviews, and review comments, then asks OpenCode to preserve Renovate's proposed bumps, refresh lockfiles, run validation, and fix scoped compatibility failures when possible.

You can add extra instruction after the command:

```text
/renovate focus on the pnpm lockfile failure
```

The command only runs when `pull_requests: true` and the comment is on a pull request or pull request review thread.

## Required caller secrets

For OpenRouter, add these secrets to the caller repo:

- `OPENROUTER_API_KEY`
- `LANGFUSE_PUBLIC_KEY`
- `LANGFUSE_SECRET_KEY`
- `LANGFUSE_BASE_URL`

Then target repositories pass the OpenRouter model slug prefixed with `openrouter/`:

```yaml
with:
  model: openrouter/z-ai/glm-4.7-flash
```

OpenRouter uses `https://openrouter.ai/api/v1` by default. Set `OPENROUTER_BASE_URL` only if you need to override that endpoint.

## Skills

Bundled skills live in `skills/<name>/SKILL.md`.

Consuming repos can add or override skills with `.agent/skills/<name>/SKILL.md`.
