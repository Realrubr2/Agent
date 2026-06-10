export const USER_EVENTS = ["issue_comment", "pull_request_review_comment", "issues", "pull_request"] as const
export const REPO_EVENTS = ["schedule", "workflow_dispatch"] as const
export const SUPPORTED_EVENTS = [...USER_EVENTS, ...REPO_EVENTS] as const

export type AgentMode = "comment" | "review" | "triage" | "schedule"

export function parseMentionPrompt(body: string, mentionsInput?: string) {
  const mentions = (mentionsInput || "/agent")
    .split(",")
    .map((mention) => mention.trim().toLowerCase())
    .filter(Boolean)
  const trimmed = body.trim()
  const lower = trimmed.toLowerCase()
  const mention = mentions.find((candidate) => mentionPattern(candidate).test(lower))
  if (!mention) return { matched: false, mentions, prompt: trimmed }
  const prompt = trimmed.replace(mentionPattern(mention), "").replace(/\s+/g, " ").trim()
  return { matched: true, mentions, prompt }
}

export function inferMode(eventName: string, isPullRequest: boolean, explicitMode?: string): AgentMode {
  if (explicitMode) return normalizeMode(explicitMode)
  if (eventName === "schedule" || eventName === "workflow_dispatch") return "schedule"
  if (eventName === "issues") return "triage"
  if (eventName === "pull_request" || eventName === "pull_request_review_comment" || isPullRequest) return "review"
  return "comment"
}

export function selectModel(input: {
  mode: AgentMode
  model: string
  reviewModel?: string
  scheduleModel?: string
  triageModel?: string
}) {
  if (input.mode === "review") return input.reviewModel || input.model
  if (input.mode === "schedule") return input.scheduleModel || input.model
  if (input.mode === "triage") return input.triageModel || input.model
  return input.model
}

export function requireModel(value: string) {
  const [provider, ...modelParts] = value.split("/")
  const model = modelParts.join("/")
  if (!provider || !model) throw new Error(`Invalid model "${value}". Expected provider/model.`)
  if (provider !== "openrouter") throw new Error(`Unsupported provider "${provider}". Only openrouter models are supported.`)
  return { provider, model }
}

export type PublishTargetInput = {
  owner: string
  repo: string
  runId: string
  defaultBranch: string
  issueNumber?: number
  pullRequest?: {
    headRef: string
    headRepoFullName: string
    baseRef: string
  }
}

export type PublishTarget = {
  branchName: string
  baseBranch: string
  issueNumber?: number
  fallbackNote?: string
}

export function choosePublishTarget(input: PublishTargetInput): PublishTarget {
  const issuePart = input.issueNumber ? String(input.issueNumber) : "run"
  const runPart = sanitizeBranchPart(input.runId || "manual")
  const branchName = `agent/${sanitizeBranchPart(issuePart)}-${runPart}`
  if (!input.pullRequest) {
    return { branchName, baseBranch: input.defaultBranch, issueNumber: input.issueNumber }
  }
  const repoFullName = `${input.owner}/${input.repo}`.toLowerCase()
  if (input.pullRequest.headRepoFullName.toLowerCase() === repoFullName) {
    return { branchName, baseBranch: input.pullRequest.headRef, issueNumber: input.issueNumber }
  }
  return {
    branchName,
    baseBranch: input.pullRequest.baseRef,
    issueNumber: input.issueNumber,
    fallbackNote:
      "The original pull request branch is from a fork, so I opened this helper PR against the original PR base branch instead.",
  }
}

export function extractOpencodeResponse(result: {
  data?: { info?: { error?: unknown }; parts?: Array<{ type?: string; text?: string; ignored?: boolean }> }
  error?: unknown
}) {
  if (result.error) throw new Error(`OpenCode request failed: ${formatUnknownError(result.error)}`)
  if (!result.data) throw new Error("OpenCode request failed: missing response data")
  if (result.data.info?.error) throw new Error(`OpenCode message failed: ${formatUnknownError(result.data.info.error)}`)
  const text = (result.data.parts || [])
    .filter((part) => part.type === "text" && !part.ignored && part.text)
    .map((part) => part.text!.trim())
    .filter(Boolean)
    .join("\n\n")
  return text || "OpenCode completed without a text response."
}

export function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/(sk-|ghp_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9_\-]+/g, "[REDACTED_TOKEN]")
      .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]")
  }
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /token|secret|password|key|authorization/i.test(key) ? "[REDACTED]" : redact(item),
    ]),
  )
}

export function requireEnv(env: Record<string, string | undefined>, names: string[]) {
  const missing = names.filter((name) => !env[name])
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`)
}

function normalizeMode(value: string): AgentMode {
  if (value === "comment" || value === "review" || value === "triage" || value === "schedule") return value
  throw new Error(`Invalid mode "${value}". Expected comment, review, triage, or schedule.`)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function mentionPattern(value: string) {
  return new RegExp(`(?:^|\\s)${escapeRegExp(value)}(?=$|\\s)`, "i")
}

function sanitizeBranchPart(value: string) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown"
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const value = error as { name?: unknown; data?: unknown; message?: unknown }
    const name = typeof value.name === "string" ? value.name : "Error"
    const message =
      typeof value.message === "string"
        ? value.message
        : value.data && typeof value.data === "object" && "message" in value.data && typeof value.data.message === "string"
          ? value.data.message
          : JSON.stringify(error)
    return `${name}: ${message}`
  }
  return String(error)
}
