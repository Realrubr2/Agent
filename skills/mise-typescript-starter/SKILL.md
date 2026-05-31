---
name: mise-typescript-starter
description: Create, scaffold, bootstrap, or start a new TypeScript, Node, web, or full-stack project from scratch using mise with Node.js 24, pnpm, strict TypeScript, Vitest, npm-check-updates, and spec-driven design.
---

# Mise TypeScript Starter

Use this skill when creating a new project from scratch. The default stack is strict and should be used unless the user's request makes it technically impossible: mise, Node.js 24, pnpm, TypeScript, Vitest, and spec-driven design.

## Core Workflow

1. Write a short implementation spec before scaffolding:
   - Goal and audience.
   - Primary user workflows.
   - Acceptance criteria.
   - Data shapes, API shape, or CLI I/O when relevant.
   - Edge cases and failure modes.
   - Verification plan.
2. Scaffold the smallest real project that satisfies the spec.
3. Use tests to prove the requested behavior works.
4. Run the relevant checks and report exact commands/results.

## Required Tooling

- Use `mise` for runtime/tool management.
- Always create or update `.mise.toml` with Node.js 24:

```toml
[tools]
node = "24"
```

- Use `pnpm` for package management.
- Always run `npx npm-check-updates` before finalizing dependency versions or upgrade decisions.
- Use TypeScript with strict compiler settings.
- Use Vitest for automated tests.

## Project Defaults

Prefer this baseline unless the requested project type needs a framework-specific variant:

- `src/` for implementation code.
- `tests/` or colocated `*.test.ts` files for Vitest tests.
- `package.json` scripts:
  - `dev`
  - `build`
  - `test`
  - `test:watch`
  - `typecheck`
  - `check`
- `tsconfig.json` with strictness enabled.
- `.gitignore` covering `node_modules`, build output, coverage, and local env files.
- `tsx` for TypeScript execution when a runtime entrypoint is useful.

## Implementation Standards

- Build executable behavior, not placeholder demos.
- Keep modules small and typed at their boundaries.
- Avoid unnecessary frameworks, dependencies, abstractions, and features.
- Prefer boring direct code over clever generic machinery.
- Add tests for the behavior the user asked for, including important edge cases.
- If building a frontend, include UI verification or a screenshot when feasible.
- If any required tool or command cannot run, state the reason and choose the closest safe verification path.

## Dependency Flow

1. Initialize with pnpm.
2. Add only dependencies required by the spec.
3. Run `npx npm-check-updates`.
4. Apply dependency updates intentionally.
5. Run `pnpm install`.
6. Run `pnpm check` or the closest available full verification command.

## Final Response Expectations

Summarize:

- What was built.
- The spec or acceptance criteria covered.
- Tests/checks run and their result.
- Any verification that could not be completed.
