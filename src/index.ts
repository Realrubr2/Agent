import fs from "node:fs/promises"
import path from "node:path"
import { SUPPORTED_EVENTS, inferMode, parseMentionPrompt, redact, requireEnv, requireModel, selectModel } from "./core"

type GitHubContext = {
  eventName: string
  event: any
  owner: string
  repo: string
  actor: string
  runId: string
  runUrl: string
  workspace: string
}

type Skill = {
  name: string
  source: "bundled" | "repo"
  body: string
}

const started = Date.now()
const traceId = crypto.randomUUID()
let langfuse: LangfuseClient
const OPENAI_COMPATIBLE_DEFAULT_BASE_URLS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1",
}

async function main() {
  requireEnv(process.env, ["GITHUB_TOKEN", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL"])
  const inputs = readInputs()
  langfuse = new LangfuseClient({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
    secretKey: process.env.LANGFUSE_SECRET_KEY!,
    baseUrl: process.env.LANGFUSE_BASE_URL!,
    includePrompts: inputs.telemetryIncludePrompts,
  })
  const context = await withSpan("event parsing", () => readContext())
  if (!SUPPORTED_EVENTS.includes(context.eventName as (typeof SUPPORTED_EVENTS)[number])) {
    throw new Error(`Unsupported event type: ${context.eventName}`)
  }
  const isPullRequest = isPullRequestEvent(context)
  const mode = inferMode(context.eventName, isPullRequest, inputs.mode)
  const selectedModel = selectModel({
    mode,
    model: inputs.model,
    reviewModel: inputs.reviewModel,
    scheduleModel: inputs.scheduleModel,
    triageModel: inputs.triageModel,
  })
  const model = requireModel(selectedModel)

  await langfuse.createTrace({
    repo: `${context.owner}/${context.repo}`,
    workflow: process.env.GITHUB_WORKFLOW,
    event_type: context.eventName,
    actor: context.actor,
    run_url: context.runUrl,
    mode,
    model: selectedModel,
  })

  const github = new GitHubClient(process.env.GITHUB_TOKEN!, context.owner, context.repo)
  const prompt = await withSpan("GitHub context loading", () => buildPrompt(context, inputs, mode, github))
  if (isUserEvent(context.eventName)) {
    await withSpan("permission check", () => assertWritePermission(github, context.actor))
  }
  const skills = await withSpan("skill loading", () => loadSkills(inputs.skills, context.workspace))
  await langfuse.updateTrace("running", { skills: skills.map((skill) => skill.name) })
  const response = await withSpan("agent execution", () => runAgent(model, prompt, skills, inputs.telemetryIncludePrompts))
  const diff = await withSpan("git diff detection", () => gitDiff(context.workspace))
  await withSpan("comment, commit, or PR publishing", () => publishResult(context, github, response, diff))
  await langfuse.updateTrace("success", { duration_ms: Date.now() - started, changed: diff.changed })
}

function readInputs() {
  const model = process.env.INPUT_MODEL
  if (!model) throw new Error("Input model is required")
  return {
    model,
    reviewModel: process.env.INPUT_REVIEW_MODEL || undefined,
    scheduleModel: process.env.INPUT_SCHEDULE_MODEL || undefined,
    triageModel: process.env.INPUT_TRIAGE_MODEL || undefined,
    mode: process.env.INPUT_MODE || undefined,
    prompt: process.env.INPUT_PROMPT || undefined,
    mentions: process.env.INPUT_MENTIONS || "/agent",
    skills: process.env.INPUT_SKILLS || undefined,
    telemetryIncludePrompts: process.env.INPUT_TELEMETRY_INCLUDE_PROMPTS === "true",
  }
}

async function readContext(): Promise<GitHubContext> {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required")
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || "").split("/")
  if (!owner || !repo) throw new Error("GITHUB_REPOSITORY must be owner/repo")
  return {
    eventName: process.env.GITHUB_EVENT_NAME || "",
    event: JSON.parse(await fs.readFile(eventPath, "utf8")),
    owner,
    repo,
    actor: process.env.GITHUB_ACTOR || "",
    runId: process.env.GITHUB_RUN_ID || "",
    runUrl: `https://github.com/${owner}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID || ""}`,
    workspace: process.cwd(),
  }
}

async function buildPrompt(context: GitHubContext, inputs: ReturnType<typeof readInputs>, mode: string, github: GitHubClient) {
  if (inputs.prompt) return inputs.prompt
  if (context.eventName === "schedule" || context.eventName === "workflow_dispatch" || context.eventName === "issues") {
    throw new Error("Input prompt is required for schedule, workflow_dispatch, and issues events")
  }
  const comment = context.event.comment?.body || ""
  const parsed = parseMentionPrompt(comment, inputs.mentions)
  if (!parsed.matched) throw new Error(`Comment must mention ${parsed.mentions.map((item) => "`" + item + "`").join(" or ")}`)
  const issueNumber = getIssueNumber(context)
  const contextData = issueNumber ? await github.issueContext(issueNumber) : ""
  const reviewData =
    context.eventName === "pull_request_review_comment"
      ? [
          "<review_comment_context>",
          `File: ${context.event.comment.path}`,
          `Line: ${context.event.comment.line ?? context.event.comment.original_line ?? "unknown"}`,
          context.event.comment.diff_hunk || "",
          "</review_comment_context>",
        ].join("\n")
      : ""
  return [parsed.prompt || (mode === "review" ? "Review this pull request" : "Summarize this thread"), contextData, reviewData]
    .filter(Boolean)
    .join("\n\n")
}

async function loadSkills(allowlist: string | undefined, workspace: string): Promise<Skill[]> {
  const bundled = await readSkills(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../skills"), "bundled")
  const repo = await readSkills(path.join(workspace, ".agent/skills"), "repo")
  const merged = new Map<string, Skill>()
  for (const skill of bundled) merged.set(skill.name, skill)
  for (const skill of repo) merged.set(skill.name, skill)
  const names = allowlist
    ? allowlist
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [...merged.keys()].sort()
  return names.map((name) => {
    const skill = merged.get(name)
    if (!skill) throw new Error(`Skill "${name}" was requested but not found`)
    return skill
  })
}

async function runAgent(model: { provider: string; model: string }, prompt: string, skills: Skill[], includeTelemetryPayload: boolean) {
  const system = [
    "You are running as a shared GitHub repository agent.",
    "Be concise, specific, and action-oriented.",
    "If you cannot safely make changes, explain exactly what you checked and why.",
    ...skills.map((skill) => `<skill name="${skill.name}" source="${skill.source}">\n${skill.body}\n</skill>`),
  ].join("\n\n")
  await langfuse.generationStart(model, includeTelemetryPayload ? { system, prompt } : undefined)
  const response =
    model.provider === "anthropic"
      ? await callAnthropic(model.model, system, prompt)
      : model.provider === "openai"
        ? await callOpenAI(model.model, system, prompt)
        : await callOpenAICompatible(model.provider, model.model, system, prompt)
  await langfuse.generationEnd(includeTelemetryPayload ? response : undefined)
  return response
}

async function publishResult(context: GitHubContext, github: GitHubClient, response: string, diff: { changed: boolean }) {
  if (isUserEvent(context.eventName)) {
    const issueNumber = getIssueNumber(context)
    if (!issueNumber) return
    await github.comment(issueNumber, `${response}\n\n[agent run](${context.runUrl})`)
    return
  }
  console.log(response)
  if (diff.changed) {
    console.log("Files changed, but branch/PR publishing is intentionally left to the agent implementation adapter.")
  }
}

async function readSkills(dir: string, source: "bundled" | "repo"): Promise<Skill[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const skills = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => ({
          name: entry.name,
          source,
          body: await fs.readFile(path.join(dir, entry.name, "SKILL.md"), "utf8"),
        })),
    )
    return skills
  } catch {
    return []
  }
}

async function gitDiff(workspace: string) {
  const { spawn } = await import("node:child_process")
  return new Promise<{ changed: boolean }>((resolve) => {
    const proc = spawn("git", ["status", "--porcelain"], { cwd: workspace })
    let stdout = ""
    proc.stdout.on("data", (chunk) => (stdout += chunk))
    proc.on("close", () => resolve({ changed: stdout.trim().length > 0 }))
  })
}

function isPullRequestEvent(context: GitHubContext) {
  return Boolean(context.event.pull_request || context.event.issue?.pull_request)
}

function isUserEvent(eventName: string) {
  return ["issue_comment", "pull_request_review_comment", "issues", "pull_request"].includes(eventName)
}

function getIssueNumber(context: GitHubContext) {
  return context.event.issue?.number || context.event.pull_request?.number
}

async function assertWritePermission(github: GitHubClient, actor: string) {
  const permission = await github.permission(actor)
  if (!["admin", "write"].includes(permission)) throw new Error(`User ${actor} does not have write permissions`)
}

async function withSpan<T>(name: string, fn: () => Promise<T>) {
  const started = Date.now()
  const spanId = crypto.randomUUID()
  if (langfuse) await langfuse.spanStart(spanId, name)
  try {
    const result = await fn()
    if (langfuse) await langfuse.spanEnd(spanId, "success", Date.now() - started)
    return result
  } catch (error) {
    if (langfuse) await langfuse.spanEnd(spanId, "error", Date.now() - started, error)
    throw error
  }
}

class GitHubClient {
  constructor(
    private token: string,
    private owner: string,
    private repo: string,
  ) {}

  async permission(actor: string) {
    const data = await this.request<{ permission: string }>(
      `/repos/${this.owner}/${this.repo}/collaborators/${actor}/permission`,
    )
    return data.permission
  }

  async comment(issueNumber: number, body: string) {
    await this.request(`/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    })
  }

  async issueContext(issueNumber: number) {
    const issue = await this.request<any>(`/repos/${this.owner}/${this.repo}/issues/${issueNumber}`)
    const comments = await this.request<any[]>(`/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments?per_page=100`)
    return [
      "<github_context>",
      `Title: ${issue.title}`,
      `Author: ${issue.user?.login}`,
      `State: ${issue.state}`,
      issue.body || "",
      comments.length ? "<comments>" : "",
      ...comments.map((comment) => `- ${comment.user?.login}: ${comment.body}`),
      comments.length ? "</comments>" : "",
      "</github_context>",
    ].join("\n")
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...init?.headers,
      },
    })
    if (!response.ok) throw new Error(`GitHub API failed: ${response.status} ${response.statusText}`)
    return (await response.json()) as T
  }
}

class LangfuseClient {
  private generationId: string | undefined

  constructor(
    private config: { publicKey: string; secretKey: string; baseUrl: string; includePrompts: boolean },
  ) {}

  async createTrace(metadata: Record<string, unknown>) {
    await this.ingest("trace-create", traceId, {
      name: "shared-agent-run",
      metadata: redact(metadata),
    })
  }

  async updateTrace(status: string, metadata: Record<string, unknown>) {
    await this.ingest("trace-update", traceId, {
      metadata: redact({ status, ...metadata }),
    })
  }

  async spanStart(id: string, name: string) {
    await this.ingest("span-create", id, { traceId, name })
  }

  async spanEnd(id: string, status: string, durationMs: number, error?: unknown) {
    await this.ingest("span-update", id, {
      endTime: new Date().toISOString(),
      metadata: redact({ status, duration_ms: durationMs, error: error instanceof Error ? error.message : error }),
    })
  }

  async generationStart(model: { provider: string; model: string }, input?: unknown) {
    this.generationId = crypto.randomUUID()
    await this.ingest("generation-create", this.generationId, {
      traceId,
      name: "agent",
      model: `${model.provider}/${model.model}`,
      input: this.config.includePrompts ? redact(input) : undefined,
    })
  }

  async generationEnd(output?: unknown) {
    if (!this.generationId) return
    await this.ingest("generation-update", this.generationId, {
      endTime: new Date().toISOString(),
      output: this.config.includePrompts ? redact(output) : undefined,
    })
  }

  private async ingest(type: string, id: string, body: Record<string, unknown>) {
    const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, "")}/api/public/ingestion`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.publicKey}:${this.config.secretKey}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        batch: [
          {
            id: crypto.randomUUID(),
            type,
            timestamp: new Date().toISOString(),
            body: { id, ...body },
          },
        ],
      }),
    })
    if (!response.ok) console.warn(`Langfuse ingestion failed: ${response.status} ${response.statusText}`)
  }
}

async function callAnthropic(model: string, system: string, prompt: string) {
  requireEnv(process.env, ["ANTHROPIC_API_KEY"])
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: prompt }],
    }),
  })
  if (!response.ok) throw new Error(`Anthropic request failed: ${response.status} ${response.statusText}`)
  const data = (await response.json()) as any
  return data.content?.map((item: any) => item.text).filter(Boolean).join("\n") || ""
}

async function callOpenAI(model: string, system: string, prompt: string) {
  requireEnv(process.env, ["OPENAI_API_KEY"])
  return callChatCompletions("https://api.openai.com/v1/chat/completions", process.env.OPENAI_API_KEY!, model, system, prompt)
}

async function callOpenAICompatible(provider: string, model: string, system: string, prompt: string) {
  const envPrefix = provider.toUpperCase().replace(/-/g, "_")
  const baseUrl = process.env[`${envPrefix}_BASE_URL`] || OPENAI_COMPATIBLE_DEFAULT_BASE_URLS[provider]
  const apiKey = process.env[`${envPrefix}_API_KEY`]
  if (!apiKey) {
    throw new Error(`Missing required environment variables: ${envPrefix}_API_KEY`)
  }
  if (!baseUrl) {
    throw new Error(`Unsupported provider "${provider}". Set ${envPrefix}_BASE_URL and ${envPrefix}_API_KEY for OpenAI-compatible providers.`)
  }
  return callChatCompletions(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, apiKey, model, system, prompt)
}

async function callChatCompletions(url: string, apiKey: string, model: string, system: string, prompt: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
  })
  if (!response.ok) throw new Error(`Model request failed: ${response.status} ${response.statusText}`)
  const data = (await response.json()) as any
  return data.choices?.[0]?.message?.content || ""
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error))
  if (langfuse) {
    await langfuse.updateTrace("error", {
      error: error instanceof Error ? error.message : String(error),
      duration_ms: Date.now() - started,
    })
  }
  process.exitCode = 1
})
