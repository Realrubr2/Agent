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
  return { provider, model }
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
