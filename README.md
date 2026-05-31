# Reusable GitHub Codex Agent

This repository is the central agent repo. It owns the reusable GitHub Actions workflows, the glue script, and the bundled skills.

Each application repository only needs tiny workflow stubs plus secrets.

## What This Agent Does

- `/agent plan` or `/codex plan` on an issue creates an implementation plan comment.
- `/agent approve` or `/codex approve` on that issue runs Codex, commits the implementation to a branch, and opens a pull request.
- `/agent improve <request>` or `/codex improve <request>` on the pull request updates the PR branch.

The reusable workflows install these bundled skills into the runner before Codex runs:

- `mise-typescript-starter` for new TypeScript project creation and implementation work.
- `code-review` for PR review, review feedback, and maintainability passes.
- `control-ui` for frontend verification, browser checks, and screenshots.

## Central Repo Layout

```text
.
|-- .github/workflows/
|   |-- reusable-plan.yml
|   |-- reusable-implement.yml
|   `-- reusable-pr-followup.yml
|-- src/
|   `-- agent-glue.mjs
|-- skills/
|   |-- code-review/
|   |   `-- SKILL.md
|   |-- control-ui/
|   |   `-- SKILL.md
|   `-- mise-typescript-starter/
|       `-- SKILL.md
`-- examples/app-repo-workflows/
    |-- agent-plan.yml
    |-- agent-implement.yml
    `-- agent-pr-followup.yml
```

## App Repo Setup

Copy the files from `examples/app-repo-workflows/` into the application repo's `.github/workflows/` directory.

The app repo should end up with:

```text
.github/workflows/
|-- agent-plan.yml
|-- agent-implement.yml
`-- agent-pr-followup.yml
```

By default the example stubs call:

```yaml
uses: Realrubr2/opencode-agent/.github/workflows/reusable-plan.yml@main
```

If the central repo is named differently, replace `Realrubr2/opencode-agent` in all three app workflow stubs.

## Required Secrets

Add these secrets to every app repo that will use the agent:

- `OPENAI_API_KEY`
- `LANGFUSE_PUBLIC_KEY` optional
- `LANGFUSE_SECRET_KEY` optional
- `LANGFUSE_HOST` optional, defaults to Langfuse Cloud behavior in the glue script

The workflow uses GitHub's built-in `GITHUB_TOKEN` for comments, labels, branches, and pull requests.

## Permissions

The app workflow stubs include the required permissions:

- `contents: read` for planning.
- `contents: write` for implementation and PR follow-up.
- `issues: write` for issue comments and labels.
- `pull-requests: write` for PR creation and updates.
- `actions: read`.

Repository settings must allow GitHub Actions to create and approve pull requests if your org/repo restricts that.

## Trust Gate

Only users with these author associations can trigger the agent by default:

```text
OWNER,MEMBER,COLLABORATOR
```

To override that per app repo, pass `allowed_associations` from a stub:

```yaml
jobs:
  plan:
    uses: Realrubr2/opencode-agent/.github/workflows/reusable-plan.yml@main
    with:
      allowed_associations: OWNER,MEMBER,COLLABORATOR
    secrets: inherit
```

Keep this strict for public repositories because the agent can spend API credits and write code.

## Optional Version Pinning

For stability, replace `@main` in app repo workflow stubs with a tag:

```yaml
uses: Realrubr2/opencode-agent/.github/workflows/reusable-plan.yml@v0.1.0
```

Then release new central-agent versions by tagging this repo.

## Commands

In an app repo issue:

```text
/agent plan
```

After reviewing the plan:

```text
/agent approve
```

On the generated PR:

```text
/agent improve make the tests cover the empty state too
```

Aliases with `/codex` also work:

```text
/codex plan
/codex approve
/codex improve ...
```

## Local Check

Run this in the central agent repo:

```bash
npm run check
```
