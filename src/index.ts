import fs from "node:fs/promises"
import path from "node:path"
import { createOpencode, type Config } from "@opencode-ai/sdk"
import {
  SUPPORTED_EVENTS,
  choosePublishTarget,
  extractOpencodeResponse,
  inferMode,
  parseMentionPrompt,
  redact,
  requireEnv,
  requireModel,
  selectModel,
  type PublishTarget,
} from "./core"

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

async function main() {
  requireEnv(process.env, [
    "GITHUB_TOKEN",
    "LANGFUSE_PUBLIC_KEY",
    "LANGFUSE_SECRET_KEY",
    "LANGFUSE_BASE_URL",
    "OPENROUTER_API_KEY",
  ])
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
  const publishTarget = await withSpan("publish target selection", () => resolvePublishTarget(context, github))
  await withSpan("workspace branch setup", () => prepareWorkspaceBranch(context.workspace, publishTarget))
  const prompt = await withSpan("GitHub context loading", () => buildPrompt(context, inputs, mode, github))
  if (isUserEvent(context.eventName)) {
    await withSpan("permission check", () => assertWritePermission(github, context.actor))
  }
  await withSpan("acknowledgement comment", () => acknowledgeInvocation(context, github))
  const skills = await withSpan("skill loading", () => loadSkills(inputs.skills, context.workspace))
  await langfuse.updateTrace("running", { skills: skills.map((skill) => skill.name) })
  const response = await withSpan("agent execution", () => runAgent(model, prompt, skills, inputs.telemetryIncludePrompts))
  const diff = await withSpan("git diff detection", () => gitDiff(context.workspace))
  await withSpan("comment, commit, or PR publishing", () => publishResult(context, github, response, diff, publishTarget))
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
    "You may inspect files, edit files, and run shell commands when useful.",
    "When you change files, summarize the changes and tests you ran.",
    "If you cannot safely make changes, explain exactly what you checked and why.",
    ...skills.map((skill) => `<skill name="${skill.name}" source="${skill.source}">\n${skill.body}\n</skill>`),
  ].join("\n\n")
  await langfuse.generationStart(model, includeTelemetryPayload ? { system, prompt } : undefined)
  const opencode = await createOpencode({
    timeout: 30000,
    config: openCodeConfig(model),
  })
  try {
    const auth = await opencode.client.auth.set({
      path: { id: "openrouter" },
      body: { type: "api", key: process.env.OPENROUTER_API_KEY! },
    })
    if (auth.error) throw new Error(`OpenCode OpenRouter auth failed: ${JSON.stringify(auth.error)}`)
    const session = await opencode.client.session.create({
      query: { directory: process.cwd() },
      body: { title: "GitHub Agent" },
    })
    if (session.error) throw new Error(`OpenCode session creation failed: ${JSON.stringify(session.error)}`)
    if (!session.data?.id) throw new Error("OpenCode session creation failed: missing session id")
    const result = await opencode.client.session.prompt({
      path: { id: session.data.id },
      query: { directory: process.cwd() },
      body: {
        model: { providerID: model.provider, modelID: model.model },
        system,
        parts: [{ type: "text", text: prompt }],
      },
    })
    const response = extractOpencodeResponse(result)
    await langfuse.generationEnd(includeTelemetryPayload ? response : undefined)
    return response
  } finally {
    opencode.server.close()
  }
}

function openCodeConfig(model: { provider: string; model: string }): Config {
  const openrouterOptions: NonNullable<NonNullable<Config["provider"]>[string]["options"]> = {
    apiKey: process.env.OPENROUTER_API_KEY!,
  }
  if (process.env.OPENROUTER_BASE_URL) openrouterOptions.baseURL = process.env.OPENROUTER_BASE_URL
  return {
    enabled_providers: ["openrouter"],
    model: `${model.provider}/${model.model}`,
    small_model: `${model.provider}/${model.model}`,
    provider: {
      openrouter: {
        id: "openrouter",
        name: "OpenRouter",
        options: openrouterOptions,
        models: {
          [model.model]: { name: model.model },
        },
      },
    },
    permission: {
      edit: "allow",
      bash: "allow",
      webfetch: "deny",
      external_directory: "deny",
    },
  }
}

async function publishResult(
  context: GitHubContext,
  github: GitHubClient,
  response: string,
  diff: { changed: boolean },
  target: PublishTarget,
) {
  if (!diff.changed) {
    if (isUserEvent(context.eventName) && target.issueNumber) {
      await github.comment(target.issueNumber, `${response}\n\n[agent run](${context.runUrl})`)
      return
    }
    console.log(response)
    return
  }

  await commitAndPush(context.workspace, target)
  const pr = await github.createPullRequest({
    title: target.issueNumber ? `Agent changes for #${target.issueNumber}` : "Agent changes",
    head: target.branchName,
    base: target.baseBranch,
    body: [response, target.fallbackNote, `[agent run](${context.runUrl})`].filter(Boolean).join("\n\n"),
  })
  const message = [response, target.fallbackNote, `Opened PR: ${pr.html_url}`, `[agent run](${context.runUrl})`]
    .filter(Boolean)
    .join("\n\n")
  if (isUserEvent(context.eventName) && target.issueNumber) {
    await github.comment(target.issueNumber, message)
    return
  }
  console.log(message)
}

async function acknowledgeInvocation(context: GitHubContext, github: GitHubClient) {
  if (!isUserEvent(context.eventName)) return
  const issueNumber = getIssueNumber(context)
  if (!issueNumber) return
  await github.comment(issueNumber, `Agent called. I'm taking a look now.\n\n[agent run](${context.runUrl})`)
}

async function resolvePublishTarget(context: GitHubContext, github: GitHubClient) {
  const issueNumber = getIssueNumber(context)
  const defaultBranch = context.event.repository?.default_branch || (await github.defaultBranch())
  const pullRequest = issueNumber && isPullRequestEvent(context) ? await pullRequestInfo(context, github, issueNumber) : undefined
  return choosePublishTarget({
    owner: context.owner,
    repo: context.repo,
    runId: context.runId,
    defaultBranch,
    issueNumber,
    pullRequest,
  })
}

async function pullRequestInfo(context: GitHubContext, github: GitHubClient, issueNumber: number) {
  const pr = context.event.pull_request || (await github.pullRequest(issueNumber))
  if (!pr.head?.ref || !pr.head?.repo?.full_name || !pr.base?.ref) {
    throw new Error(`Pull request #${issueNumber} is missing head/base branch metadata`)
  }
  return {
    headRef: pr.head.ref,
    headRepoFullName: pr.head.repo.full_name,
    baseRef: pr.base.ref,
  }
}

async function prepareWorkspaceBranch(workspace: string, target: PublishTarget) {
  await git(workspace, ["fetch", "origin", target.baseBranch])
  await git(workspace, ["checkout", "-B", target.branchName, "FETCH_HEAD"])
}

async function commitAndPush(workspace: string, target: PublishTarget) {
  await git(workspace, ["config", "user.name", "github-actions[bot]"])
  await git(workspace, ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"])
  await git(workspace, ["add", "-A"])
  await git(workspace, ["commit", "-m", target.issueNumber ? `Apply agent changes for #${target.issueNumber}` : "Apply agent changes"])
  await git(workspace, ["push", "--set-upstream", "origin", target.branchName])
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

async function git(workspace: string, args: string[]) {
  const { spawn } = await import("node:child_process")
  return new Promise<string>((resolve, reject) => {
    const proc = spawn("git", args, { cwd: workspace })
    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", (chunk) => (stdout += chunk))
    proc.stderr.on("data", (chunk) => (stderr += chunk))
    proc.on("error", reject)
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout)
        return
      }
      reject(new Error(`git ${args.join(" ")} failed with exit code ${code}${stderr ? `: ${stderr.trim()}` : ""}`))
    })
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

  async defaultBranch() {
    const data = await this.request<{ default_branch: string }>(`/repos/${this.owner}/${this.repo}`)
    return data.default_branch
  }

  async pullRequest(number: number) {
    return this.request<any>(`/repos/${this.owner}/${this.repo}/pulls/${number}`)
  }

  async createPullRequest(input: { title: string; head: string; base: string; body: string }) {
    return this.request<{ html_url: string }>(`/repos/${this.owner}/${this.repo}/pulls`, {
      method: "POST",
      body: JSON.stringify(input),
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
