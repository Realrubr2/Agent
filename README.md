# Shared Agent GitHub Action

This directory is a portable scaffold for a shared Agent repo.

Target repos call reusable workflows from the shared repo and only pass model names. Provider keys and Langfuse credentials are centralized as environment secrets on the shared Agent repo.

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

jobs:
  agent-comment:
    if: github.event_name == 'issue_comment' || github.event_name == 'pull_request_review_comment'
    uses: Realrubr2/Agent/.github/workflows/agent.yml@v1
    with:
      model: openrouter/z-ai/glm-4.7-flash
      review_model: openrouter/z-ai/glm-4.7-flash

  agent-review:
    if: github.event_name == 'pull_request'
    uses: Realrubr2/Agent/.github/workflows/agent.yml@v1
    with:
      model: openrouter/z-ai/glm-4.7-flash
      review_model: openrouter/z-ai/glm-4.7-flash
```

More copyable examples live in `examples/workflows`.

## Required Agent environment secrets

Create an environment named `agent` in this Agent repo and add these environment secrets:

- `LANGFUSE_PUBLIC_KEY`
- `LANGFUSE_SECRET_KEY`
- `LANGFUSE_BASE_URL`
- Provider key for the selected model, for example `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY`

For OpenRouter, create an API key in OpenRouter and save it as the `OPENROUTER_API_KEY` environment secret on the Agent repo's `agent` environment. Target repositories only pass an OpenRouter model slug prefixed with `openrouter/`:

```yaml
with:
  model: openrouter/z-ai/glm-4.7-flash
```

OpenRouter uses `https://openrouter.ai/api/v1` by default. Set `OPENROUTER_BASE_URL` only if you need to override that endpoint.

## Skills

Bundled skills live in `skills/<name>/SKILL.md`.

Consuming repos can add or override skills with `.agent/skills/<name>/SKILL.md`.
