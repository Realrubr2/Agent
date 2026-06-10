# Shared Agent GitHub Action

This directory is a portable scaffold for a shared Agent repo.

Target repos call reusable workflows from the shared repo and pass OpenRouter model names. The action runs OpenCode with OpenRouter, allowing it to edit files and run shell commands in the checked-out repository.

GitHub does not expose this Agent repo's secrets to workflow runs in other repositories. Without a GitHub organization, add provider and telemetry secrets to each caller repo, then keep `secrets: inherit` in the caller workflow.

## Caller workflow

```yaml
name: Agent

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: write
  issues: write
  pull-requests: write

jobs:
  agent-comment:
    if: github.event_name == 'issue_comment' || github.event_name == 'pull_request_review_comment'
    uses: Realrubr2/Agent/.github/workflows/agent.yml@main
    with:
      model: openrouter/z-ai/glm-4.7-flash
      review_model: openrouter/z-ai/glm-4.7-flash
    secrets: inherit

  agent-review:
    if: github.event_name == 'pull_request'
    uses: Realrubr2/Agent/.github/workflows/agent.yml@main
    with:
      model: openrouter/z-ai/glm-4.7-flash
      review_model: openrouter/z-ai/glm-4.7-flash
    secrets: inherit
```

More copyable examples live in `examples/workflows`.

When OpenCode changes files, the action opens a helper pull request from an `agent/<issue>-<run>` branch. If no files changed, it only comments with the agent response.

The caller repo must allow workflows to create pull requests. In the caller repo, open `Settings -> Actions -> General -> Workflow permissions`, choose `Read and write permissions`, and enable `Allow GitHub Actions to create and approve pull requests`.

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
