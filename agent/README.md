# Shared Agent GitHub Action

This directory is a portable scaffold for a shared Agent repo.

Target repos call reusable workflows from the shared repo and only pass model names. Provider keys and Langfuse credentials are expected to be organization secrets inherited by the reusable workflow.

## Caller workflow

```yaml
name: Agent

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

jobs:
  agent:
    uses: Realrubr2/Agent/.github/workflows/agent-comment.yml@v1
    with:
      model: anthropic/claude-sonnet-4-5
    secrets: inherit
```

More copyable examples live in `agent/examples/workflows`.

## Required organization secrets

- `LANGFUSE_PUBLIC_KEY`
- `LANGFUSE_SECRET_KEY`
- `LANGFUSE_BASE_URL`
- Provider key for the selected model, for example `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`

## Skills

Bundled skills live in `agent/skills/<name>/SKILL.md`.

Consuming repos can add or override skills with `.agent/skills/<name>/SKILL.md`.
