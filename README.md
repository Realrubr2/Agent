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
      model: openrouter/openai/gpt-5.2
    secrets: inherit
```

More copyable examples live in `examples/workflows`.

## Required organization secrets

- `LANGFUSE_PUBLIC_KEY`
- `LANGFUSE_SECRET_KEY`
- `LANGFUSE_BASE_URL`
- Provider key for the selected model, for example `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY`

For OpenRouter, create an API key in OpenRouter and save it as the GitHub organization secret `OPENROUTER_API_KEY`. Then use an OpenRouter model by prefixing the OpenRouter model slug with `openrouter/`:

```yaml
with:
  model: openrouter/openai/gpt-5.2
secrets: inherit
```

OpenRouter uses `https://openrouter.ai/api/v1` by default. Set `OPENROUTER_BASE_URL` only if you need to override that endpoint.

## Skills

Bundled skills live in `agent/skills/<name>/SKILL.md`.

Consuming repos can add or override skills with `.agent/skills/<name>/SKILL.md`.
