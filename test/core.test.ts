import { describe, expect, test } from "bun:test"
import {
  choosePublishTarget,
  extractOpencodeResponse,
  inferMode,
  parseMentionPrompt,
  redact,
  requireEnv,
  requireModel,
  selectModel,
} from "../src/core"

describe("parseMentionPrompt", () => {
  test("matches the default command and strips it from the prompt", () => {
    expect(parseMentionPrompt("/agent fix this")).toMatchObject({
      matched: true,
      prompt: "fix this",
    })
  })

  test("supports custom mentions", () => {
    expect(parseMentionPrompt("please /ship review", "/ship,/agent")).toMatchObject({
      matched: true,
      prompt: "please review",
    })
  })

  test("does not match command prefixes inside longer words", () => {
    expect(parseMentionPrompt("/agentic is not a command")).toMatchObject({
      matched: false,
    })
  })

  test("does not match unrelated comments", () => {
    expect(parseMentionPrompt("normal comment")).toMatchObject({
      matched: false,
      prompt: "normal comment",
    })
  })
})

describe("mode and model selection", () => {
  test("infers review for pull request contexts", () => {
    expect(inferMode("issue_comment", true)).toBe("review")
    expect(inferMode("pull_request_review_comment", false)).toBe("review")
  })

  test("infers schedule and triage modes", () => {
    expect(inferMode("schedule", false)).toBe("schedule")
    expect(inferMode("issues", false)).toBe("triage")
  })

  test("selects per-mode model overrides", () => {
    expect(
      selectModel({
        mode: "review",
        model: "openrouter/z-ai/glm-4.7-flash",
        reviewModel: "openrouter/openai/gpt-5",
      }),
    ).toBe("openrouter/openai/gpt-5")
  })

  test("validates provider/model format", () => {
    expect(requireModel("openrouter/z-ai/glm-4.7-flash")).toEqual({
      provider: "openrouter",
      model: "z-ai/glm-4.7-flash",
    })
    expect(() => requireModel("gpt-5")).toThrow("Expected provider/model")
    expect(() => requireModel("openai/gpt-5")).toThrow("Only openrouter models are supported")
  })
})

describe("opencode helpers", () => {
  test("extracts text parts from an OpenCode response", () => {
    expect(
      extractOpencodeResponse({
        data: {
          parts: [
            { type: "text", text: "Changed files." },
            { type: "reasoning", text: "hidden" },
            { type: "text", text: "Ran tests." },
          ],
        },
      }),
    ).toBe("Changed files.\n\nRan tests.")
  })

  test("reports OpenCode message errors clearly", () => {
    expect(() =>
      extractOpencodeResponse({
        data: {
          info: { error: { name: "ProviderAuthError", data: { message: "bad key" } } },
          parts: [],
        },
      }),
    ).toThrow("ProviderAuthError: bad key")
  })
})

describe("publish target selection", () => {
  test("targets the default branch for issue runs", () => {
    expect(
      choosePublishTarget({
        owner: "Realrubr2",
        repo: "motomoto",
        runId: "123",
        defaultBranch: "main",
        issueNumber: 7,
      }),
    ).toMatchObject({
      branchName: "agent/7-123",
      baseBranch: "main",
      issueNumber: 7,
    })
  })

  test("targets the original PR branch for same-repo pull requests", () => {
    expect(
      choosePublishTarget({
        owner: "Realrubr2",
        repo: "motomoto",
        runId: "123",
        defaultBranch: "main",
        issueNumber: 8,
        pullRequest: {
          headRef: "feature/fix",
          headRepoFullName: "Realrubr2/motomoto",
          baseRef: "main",
        },
      }),
    ).toMatchObject({
      branchName: "agent/8-123",
      baseBranch: "feature/fix",
      issueNumber: 8,
    })
  })

  test("falls back to the base branch for fork pull requests", () => {
    const target = choosePublishTarget({
      owner: "Realrubr2",
      repo: "motomoto",
      runId: "123",
      defaultBranch: "main",
      issueNumber: 9,
      pullRequest: {
        headRef: "fix",
        headRepoFullName: "someone/motomoto",
        baseRef: "main",
      },
    })
    expect(target).toMatchObject({
      branchName: "agent/9-123",
      baseBranch: "main",
      issueNumber: 9,
    })
    expect(target.fallbackNote).toContain("from a fork")
  })
})

describe("env and telemetry redaction", () => {
  test("reports missing env vars", () => {
    expect(() => requireEnv({}, ["LANGFUSE_PUBLIC_KEY"])).toThrow("LANGFUSE_PUBLIC_KEY")
  })

  test("redacts secret-shaped keys and token values", () => {
    expect(
      redact({
        authorization: "Bearer abc.def",
        message: "token sk-test123 should be hidden",
        nested: { apiKey: "secret" },
      }),
    ).toEqual({
      authorization: "[REDACTED]",
      message: "token [REDACTED_TOKEN] should be hidden",
      nested: { apiKey: "[REDACTED]" },
    })
  })
})
