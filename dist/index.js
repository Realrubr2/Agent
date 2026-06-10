import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/index.ts
import fs from "node:fs/promises";
import path from "node:path";

// src/core.ts
var USER_EVENTS = ["issue_comment", "pull_request_review_comment", "issues", "pull_request"];
var REPO_EVENTS = ["schedule", "workflow_dispatch"];
var SUPPORTED_EVENTS = [...USER_EVENTS, ...REPO_EVENTS];
function parseMentionPrompt(body, mentionsInput) {
  const mentions = (mentionsInput || "/agent").split(",").map((mention2) => mention2.trim().toLowerCase()).filter(Boolean);
  const trimmed = body.trim();
  const lower = trimmed.toLowerCase();
  const mention = mentions.find((candidate) => mentionPattern(candidate).test(lower));
  if (!mention)
    return { matched: false, mentions, prompt: trimmed };
  const prompt = trimmed.replace(mentionPattern(mention), "").replace(/\s+/g, " ").trim();
  return { matched: true, mentions, prompt };
}
function inferMode(eventName, isPullRequest, explicitMode) {
  if (explicitMode)
    return normalizeMode(explicitMode);
  if (eventName === "schedule" || eventName === "workflow_dispatch")
    return "schedule";
  if (eventName === "issues")
    return "triage";
  if (eventName === "pull_request" || eventName === "pull_request_review_comment" || isPullRequest)
    return "review";
  return "comment";
}
function selectModel(input) {
  if (input.mode === "review")
    return input.reviewModel || input.model;
  if (input.mode === "schedule")
    return input.scheduleModel || input.model;
  if (input.mode === "triage")
    return input.triageModel || input.model;
  return input.model;
}
function requireModel(value) {
  const [provider, ...modelParts] = value.split("/");
  const model = modelParts.join("/");
  if (!provider || !model)
    throw new Error(`Invalid model "${value}". Expected provider/model.`);
  return { provider, model };
}
function redact(value) {
  if (typeof value === "string") {
    return value.replace(/(sk-|ghp_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9_\-]+/g, "[REDACTED_TOKEN]").replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]");
  }
  if (Array.isArray(value))
    return value.map(redact);
  if (!value || typeof value !== "object")
    return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /token|secret|password|key|authorization/i.test(key) ? "[REDACTED]" : redact(item)
  ]));
}
function requireEnv(env, names) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length)
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
}
function normalizeMode(value) {
  if (value === "comment" || value === "review" || value === "triage" || value === "schedule")
    return value;
  throw new Error(`Invalid mode "${value}". Expected comment, review, triage, or schedule.`);
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function mentionPattern(value) {
  return new RegExp(`(?:^|\\s)${escapeRegExp(value)}(?=$|\\s)`, "i");
}

// src/index.ts
var started = Date.now();
var traceId = crypto.randomUUID();
var langfuse;
var OPENAI_COMPATIBLE_DEFAULT_BASE_URLS = {
  openrouter: "https://openrouter.ai/api/v1"
};
async function main() {
  requireEnv(process.env, ["GITHUB_TOKEN", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL"]);
  const inputs = readInputs();
  langfuse = new LangfuseClient({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
    includePrompts: inputs.telemetryIncludePrompts
  });
  const context = await withSpan("event parsing", () => readContext());
  if (!SUPPORTED_EVENTS.includes(context.eventName)) {
    throw new Error(`Unsupported event type: ${context.eventName}`);
  }
  const isPullRequest = isPullRequestEvent(context);
  const mode = inferMode(context.eventName, isPullRequest, inputs.mode);
  const selectedModel = selectModel({
    mode,
    model: inputs.model,
    reviewModel: inputs.reviewModel,
    scheduleModel: inputs.scheduleModel,
    triageModel: inputs.triageModel
  });
  const model = requireModel(selectedModel);
  await langfuse.createTrace({
    repo: `${context.owner}/${context.repo}`,
    workflow: process.env.GITHUB_WORKFLOW,
    event_type: context.eventName,
    actor: context.actor,
    run_url: context.runUrl,
    mode,
    model: selectedModel
  });
  const github = new GitHubClient(process.env.GITHUB_TOKEN, context.owner, context.repo);
  const prompt = await withSpan("GitHub context loading", () => buildPrompt(context, inputs, mode, github));
  if (isUserEvent(context.eventName)) {
    await withSpan("permission check", () => assertWritePermission(github, context.actor));
  }
  await withSpan("acknowledgement comment", () => acknowledgeInvocation(context, github));
  const skills = await withSpan("skill loading", () => loadSkills(inputs.skills, context.workspace));
  await langfuse.updateTrace("running", { skills: skills.map((skill) => skill.name) });
  const response = await withSpan("agent execution", () => runAgent(model, prompt, skills, inputs.telemetryIncludePrompts));
  const diff = await withSpan("git diff detection", () => gitDiff(context.workspace));
  await withSpan("comment, commit, or PR publishing", () => publishResult(context, github, response, diff));
  await langfuse.updateTrace("success", { duration_ms: Date.now() - started, changed: diff.changed });
}
function readInputs() {
  const model = process.env.INPUT_MODEL;
  if (!model)
    throw new Error("Input model is required");
  return {
    model,
    reviewModel: process.env.INPUT_REVIEW_MODEL || undefined,
    scheduleModel: process.env.INPUT_SCHEDULE_MODEL || undefined,
    triageModel: process.env.INPUT_TRIAGE_MODEL || undefined,
    mode: process.env.INPUT_MODE || undefined,
    prompt: process.env.INPUT_PROMPT || undefined,
    mentions: process.env.INPUT_MENTIONS || "/agent",
    skills: process.env.INPUT_SKILLS || undefined,
    telemetryIncludePrompts: process.env.INPUT_TELEMETRY_INCLUDE_PROMPTS === "true"
  };
}
async function readContext() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath)
    throw new Error("GITHUB_EVENT_PATH is required");
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || "").split("/");
  if (!owner || !repo)
    throw new Error("GITHUB_REPOSITORY must be owner/repo");
  return {
    eventName: process.env.GITHUB_EVENT_NAME || "",
    event: JSON.parse(await fs.readFile(eventPath, "utf8")),
    owner,
    repo,
    actor: process.env.GITHUB_ACTOR || "",
    runId: process.env.GITHUB_RUN_ID || "",
    runUrl: `https://github.com/${owner}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID || ""}`,
    workspace: process.cwd()
  };
}
async function buildPrompt(context, inputs, mode, github) {
  if (inputs.prompt)
    return inputs.prompt;
  if (context.eventName === "schedule" || context.eventName === "workflow_dispatch" || context.eventName === "issues") {
    throw new Error("Input prompt is required for schedule, workflow_dispatch, and issues events");
  }
  const comment = context.event.comment?.body || "";
  const parsed = parseMentionPrompt(comment, inputs.mentions);
  if (!parsed.matched)
    throw new Error(`Comment must mention ${parsed.mentions.map((item) => "`" + item + "`").join(" or ")}`);
  const issueNumber = getIssueNumber(context);
  const contextData = issueNumber ? await github.issueContext(issueNumber) : "";
  const reviewData = context.eventName === "pull_request_review_comment" ? [
    "<review_comment_context>",
    `File: ${context.event.comment.path}`,
    `Line: ${context.event.comment.line ?? context.event.comment.original_line ?? "unknown"}`,
    context.event.comment.diff_hunk || "",
    "</review_comment_context>"
  ].join(`
`) : "";
  return [parsed.prompt || (mode === "review" ? "Review this pull request" : "Summarize this thread"), contextData, reviewData].filter(Boolean).join(`

`);
}
async function loadSkills(allowlist, workspace) {
  const bundled = await readSkills(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../skills"), "bundled");
  const repo = await readSkills(path.join(workspace, ".agent/skills"), "repo");
  const merged = new Map;
  for (const skill of bundled)
    merged.set(skill.name, skill);
  for (const skill of repo)
    merged.set(skill.name, skill);
  const names = allowlist ? allowlist.split(",").map((item) => item.trim()).filter(Boolean) : [...merged.keys()].sort();
  return names.map((name) => {
    const skill = merged.get(name);
    if (!skill)
      throw new Error(`Skill "${name}" was requested but not found`);
    return skill;
  });
}
async function runAgent(model, prompt, skills, includeTelemetryPayload) {
  const system = [
    "You are running as a shared GitHub repository agent.",
    "Be concise, specific, and action-oriented.",
    "If you cannot safely make changes, explain exactly what you checked and why.",
    ...skills.map((skill) => `<skill name="${skill.name}" source="${skill.source}">
${skill.body}
</skill>`)
  ].join(`

`);
  await langfuse.generationStart(model, includeTelemetryPayload ? { system, prompt } : undefined);
  const response = model.provider === "anthropic" ? await callAnthropic(model.model, system, prompt) : model.provider === "openai" ? await callOpenAI(model.model, system, prompt) : await callOpenAICompatible(model.provider, model.model, system, prompt);
  await langfuse.generationEnd(includeTelemetryPayload ? response : undefined);
  return response;
}
async function publishResult(context, github, response, diff) {
  if (isUserEvent(context.eventName)) {
    const issueNumber = getIssueNumber(context);
    if (!issueNumber)
      return;
    await github.comment(issueNumber, `${response}

[agent run](${context.runUrl})`);
    return;
  }
  console.log(response);
  if (diff.changed) {
    console.log("Files changed, but branch/PR publishing is intentionally left to the agent implementation adapter.");
  }
}
async function acknowledgeInvocation(context, github) {
  if (!isUserEvent(context.eventName))
    return;
  const issueNumber = getIssueNumber(context);
  if (!issueNumber)
    return;
  await github.comment(issueNumber, `Agent called. I'm taking a look now.

[agent run](${context.runUrl})`);
}
async function readSkills(dir, source) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const skills = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => ({
      name: entry.name,
      source,
      body: await fs.readFile(path.join(dir, entry.name, "SKILL.md"), "utf8")
    })));
    return skills;
  } catch {
    return [];
  }
}
async function gitDiff(workspace) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const proc = spawn("git", ["status", "--porcelain"], { cwd: workspace });
    let stdout = "";
    proc.stdout.on("data", (chunk) => stdout += chunk);
    proc.on("close", () => resolve({ changed: stdout.trim().length > 0 }));
  });
}
function isPullRequestEvent(context) {
  return Boolean(context.event.pull_request || context.event.issue?.pull_request);
}
function isUserEvent(eventName) {
  return ["issue_comment", "pull_request_review_comment", "issues", "pull_request"].includes(eventName);
}
function getIssueNumber(context) {
  return context.event.issue?.number || context.event.pull_request?.number;
}
async function assertWritePermission(github, actor) {
  const permission = await github.permission(actor);
  if (!["admin", "write"].includes(permission))
    throw new Error(`User ${actor} does not have write permissions`);
}
async function withSpan(name, fn) {
  const started2 = Date.now();
  const spanId = crypto.randomUUID();
  if (langfuse)
    await langfuse.spanStart(spanId, name);
  try {
    const result = await fn();
    if (langfuse)
      await langfuse.spanEnd(spanId, "success", Date.now() - started2);
    return result;
  } catch (error) {
    if (langfuse)
      await langfuse.spanEnd(spanId, "error", Date.now() - started2, error);
    throw error;
  }
}

class GitHubClient {
  token;
  owner;
  repo;
  constructor(token, owner, repo) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
  }
  async permission(actor) {
    const data = await this.request(`/repos/${this.owner}/${this.repo}/collaborators/${actor}/permission`);
    return data.permission;
  }
  async comment(issueNumber, body) {
    await this.request(`/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({ body })
    });
  }
  async issueContext(issueNumber) {
    const issue = await this.request(`/repos/${this.owner}/${this.repo}/issues/${issueNumber}`);
    const comments = await this.request(`/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments?per_page=100`);
    return [
      "<github_context>",
      `Title: ${issue.title}`,
      `Author: ${issue.user?.login}`,
      `State: ${issue.state}`,
      issue.body || "",
      comments.length ? "<comments>" : "",
      ...comments.map((comment) => `- ${comment.user?.login}: ${comment.body}`),
      comments.length ? "</comments>" : "",
      "</github_context>"
    ].join(`
`);
  }
  async request(path2, init) {
    const response = await fetch(`https://api.github.com${path2}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...init?.headers
      }
    });
    if (!response.ok)
      throw new Error(`GitHub API failed: ${response.status} ${response.statusText}`);
    return await response.json();
  }
}

class LangfuseClient {
  config;
  generationId;
  constructor(config) {
    this.config = config;
  }
  async createTrace(metadata) {
    await this.ingest("trace-create", traceId, {
      name: "shared-agent-run",
      metadata: redact(metadata)
    });
  }
  async updateTrace(status, metadata) {
    await this.ingest("trace-update", traceId, {
      metadata: redact({ status, ...metadata })
    });
  }
  async spanStart(id, name) {
    await this.ingest("span-create", id, { traceId, name });
  }
  async spanEnd(id, status, durationMs, error) {
    await this.ingest("span-update", id, {
      endTime: new Date().toISOString(),
      metadata: redact({ status, duration_ms: durationMs, error: error instanceof Error ? error.message : error })
    });
  }
  async generationStart(model, input) {
    this.generationId = crypto.randomUUID();
    await this.ingest("generation-create", this.generationId, {
      traceId,
      name: "agent",
      model: `${model.provider}/${model.model}`,
      input: this.config.includePrompts ? redact(input) : undefined
    });
  }
  async generationEnd(output) {
    if (!this.generationId)
      return;
    await this.ingest("generation-update", this.generationId, {
      endTime: new Date().toISOString(),
      output: this.config.includePrompts ? redact(output) : undefined
    });
  }
  async ingest(type, id, body) {
    const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, "")}/api/public/ingestion`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.publicKey}:${this.config.secretKey}`).toString("base64")}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        batch: [
          {
            id: crypto.randomUUID(),
            type,
            timestamp: new Date().toISOString(),
            body: { id, ...body }
          }
        ]
      })
    });
    if (!response.ok)
      console.warn(`Langfuse ingestion failed: ${response.status} ${response.statusText}`);
  }
}
async function callAnthropic(model, system, prompt) {
  requireEnv(process.env, ["ANTHROPIC_API_KEY"]);
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!response.ok)
    throw new Error(`Anthropic request failed: ${response.status} ${response.statusText}`);
  const data = await response.json();
  return data.content?.map((item) => item.text).filter(Boolean).join(`
`) || "";
}
async function callOpenAI(model, system, prompt) {
  requireEnv(process.env, ["OPENAI_API_KEY"]);
  return callChatCompletions("https://api.openai.com/v1/chat/completions", process.env.OPENAI_API_KEY, model, system, prompt);
}
async function callOpenAICompatible(provider, model, system, prompt) {
  const envPrefix = provider.toUpperCase().replace(/-/g, "_");
  const baseUrl = process.env[`${envPrefix}_BASE_URL`] || OPENAI_COMPATIBLE_DEFAULT_BASE_URLS[provider];
  const apiKey = process.env[`${envPrefix}_API_KEY`];
  if (!apiKey) {
    throw new Error(`Missing required environment variables: ${envPrefix}_API_KEY`);
  }
  if (!baseUrl) {
    throw new Error(`Unsupported provider "${provider}". Set ${envPrefix}_BASE_URL and ${envPrefix}_API_KEY for OpenAI-compatible providers.`);
  }
  return callChatCompletions(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, apiKey, model, system, prompt);
}
async function callChatCompletions(url, apiKey, model, system, prompt) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt }
      ]
    })
  });
  if (!response.ok)
    throw new Error(`Model request failed: ${response.status} ${response.statusText}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}
main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  if (langfuse) {
    await langfuse.updateTrace("error", {
      error: error instanceof Error ? error.message : String(error),
      duration_ms: Date.now() - started
    });
  }
  process.exitCode = 1;
});
