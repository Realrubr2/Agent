import { describe, expect, test } from "bun:test"
import { inferMode, parseMentionPrompt, redact, requireEnv, requireModel, selectModel } from "../src/core"

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
        model: "openai/gpt-5",
        reviewModel: "anthropic/claude-sonnet",
      }),
    ).toBe("anthropic/claude-sonnet")
  })

  test("validates provider/model format", () => {
    expect(requireModel("openai/gpt-5")).toEqual({ provider: "openai", model: "gpt-5" })
    expect(() => requireModel("gpt-5")).toThrow("Expected provider/model")
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
