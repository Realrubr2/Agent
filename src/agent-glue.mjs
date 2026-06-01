#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const COMMAND_PATTERN = /\/(agent|opencode)\s+(plan|approve|improve)\b([\s\S]*)?/i;
const PLAN_MARKER = "<!-- agent-plan:";
const AGENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(AGENT_ROOT, "..");
const OUT_DIR = path.join(AGENT_ROOT, "out");
const OUT_DIR_RELATIVE = path.relative(REPO_ROOT, OUT_DIR) || "out";
const REQUIRED_SKILLS = [
  "mise-typescript-starter for new TypeScript project creation and implementation work",
  "code-review for pull request review, review feedback, and maintainability passes",
  "control-ui for frontend verification, browser checks, and screenshots",
];

async function main() {
  const command = process.argv[2];
  ensureOutDir();

  if (command === "prepare-plan") return preparePlan();
  if (command === "post-plan") return postPlan();
  if (command === "prepare-implement") return prepareImplement();
  if (command === "build-pr-body") return buildPrBody();
  if (command === "post-implementation") return postImplementation();
  if (command === "prepare-followup") return prepareFollowup();
  if (command === "post-followup") return postFollowup();
  if (command === "trace") return await trace(process.argv[3] ?? "unknown", process.argv[4] ?? "ok");

  throw new Error(`Unknown command: ${command}`);
}

function preparePlan() {
  const event = readEvent();
  assertTrusted(event);
  const issue = event.issue;
  assertIssue(issue, "plan");

  const sourceText = event.comment?.body ?? issue.body ?? "";
  const parsed = parseCommand(sourceText);
  if (!parsed || parsed.action !== "plan") {
    throw new Error("No /agent plan or /opencode plan command found.");
  }

  const planId = idFrom(`${issue.number}:${process.env.GITHUB_RUN_ID}:${Date.now()}`).slice(0, 12);
  const requester = event.comment?.user?.login ?? issue.user?.login ?? "unknown";
  const prompt = [
    "You are the planning phase of a GitHub issue-to-PR coding agent.",
    "",
    "Analyze the repository and the issue below. Produce an implementation plan only.",
    `Do not modify tracked source files. Write the final plan to ${outputPath("plan.md")}.`,
    "",
    "Required skills for this agent run:",
    skillLines(),
    "",
    "The plan must include:",
    "- Summary",
    "- Implementation changes",
    "- Verification plan",
    "- Risks or assumptions",
    "",
    `Repository: ${process.env.GITHUB_REPOSITORY}`,
    `Issue: #${issue.number} ${issue.title}`,
    `Requester: ${requester}`,
    "",
    "Issue body:",
    fenced(issue.body ?? ""),
    "",
    event.comment ? `Planning comment:\n${fenced(event.comment.body ?? "")}` : "",
  ].filter(Boolean).join("\n");

  writeFile("plan-prompt.md", prompt);
  setOutput("prompt", prompt);
  setOutput("issue_number", String(issue.number));
  setOutput("plan_id", planId);
}

function postPlan() {
  const event = readEvent();
  const issue = event.issue;
  assertIssue(issue, "post plan");

  const plan = readOptional("plan.md") || "Agent run finished, but no plan file was produced. Please rerun `/agent plan`.";
  const planId = process.env.PLAN_ID || idFrom(`${issue.number}:${process.env.GITHUB_RUN_ID}`).slice(0, 12);
  const body = [
    `## Agent Implementation Plan`,
    "",
    plan.trim(),
    "",
    "Approve with `/agent approve` when you want me to implement this.",
    "",
    `${PLAN_MARKER}${JSON.stringify({
      issue: issue.number,
      plan_id: planId,
      run_id: process.env.GITHUB_RUN_ID,
      run_attempt: process.env.GITHUB_RUN_ATTEMPT,
    })} -->`,
  ].join("\n");

  gh("issue", "comment", String(issue.number), "--body", body);
  ensureLabels(issue.number, ["agent/planned", "agent/waiting-approval"]);
}

function prepareImplement() {
  const event = readEvent();
  assertTrusted(event);
  const issue = event.issue;
  assertIssue(issue, "implementation");

  const parsed = parseCommand(event.comment?.body ?? "");
  if (!parsed || parsed.action !== "approve") {
    throw new Error("No /agent approve or /opencode approve command found.");
  }

  const currentLabels = (issue.labels || []).map((label) => typeof label === "string" ? label : label.name);
  if (currentLabels.includes("agent/in-progress")) {
    throw new Error("This issue already has an agent implementation in progress.");
  }

  const comments = ghJson("api", `repos/${repo()}/issues/${issue.number}/comments`);
  const plans = comments.filter((comment) => typeof comment.body === "string" && comment.body.includes(PLAN_MARKER));
  if (plans.length === 0) {
    throw new Error("No agent plan comment found. Run /agent plan before approving implementation.");
  }
  ensureLabels(issue.number, ["agent/in-progress"]);

  const latestPlan = plans.at(-1);
  const planText = stripMarker(latestPlan.body);
  const branch = `agent/issue-${issue.number}-${slug(issue.title).slice(0, 42)}`;
  const prompt = [
    "You are the implementation phase of a GitHub issue-to-PR coding agent.",
    "",
    "Implement the approved plan for this issue. Keep changes focused and avoid unrelated refactors.",
    "Run the relevant tests or checks you can discover from the repo. For frontend work, create or update a screenshot/artifact when feasible.",
    `Write a concise verification summary to ${outputPath("verification.md")} before finishing.`,
    "",
    "Required skills for this agent run:",
    skillLines(),
    "",
    `Repository: ${process.env.GITHUB_REPOSITORY}`,
    `Issue: #${issue.number} ${issue.title}`,
    "",
    "Issue body:",
    fenced(issue.body ?? ""),
    "",
    "Approved plan:",
    fenced(planText),
    "",
    "Approval comment:",
    fenced(event.comment?.body ?? ""),
  ].join("\n");

  writeFile("implement-prompt.md", prompt);
  setOutput("prompt", prompt);
  setOutput("issue_number", String(issue.number));
  setOutput("branch", branch);
}

function buildPrBody() {
  const event = readEvent();
  const issue = event.issue;
  assertIssue(issue, "PR body");
  const verification = readOptional("verification.md") || "Verification summary was not produced by the agent.";
  const body = [
    `Closes #${issue.number}`,
    "",
    "## Agent Notes",
    "This pull request was generated after `/agent approve` on the linked issue.",
    "",
    "## Verification",
    verification.trim(),
  ].join("\n");
  writeFile("pr-body.md", body);
  setOutput("body_path", path.relative(REPO_ROOT, path.join(OUT_DIR, "pr-body.md")));
}

function postImplementation() {
  const event = readEvent();
  const issue = event.issue;
  assertIssue(issue, "implementation status");
  const prUrl = process.env.PR_URL || "";
  const verification = readOptional("verification.md") || "No verification summary was produced.";
  const lines = [
    "Implementation run finished.",
    prUrl ? `Pull request: ${prUrl}` : "No pull request URL was reported by the workflow.",
    "",
    "Verification:",
    verification.trim(),
  ];
  gh("issue", "comment", String(issue.number), "--body", lines.join("\n"));
  ensureLabels(issue.number, ["agent/pr-open"]);
  removeLabels(issue.number, ["agent/waiting-approval", "agent/in-progress"]);
}

function prepareFollowup() {
  const event = readEvent();
  assertTrusted(event);
  const issue = event.issue;
  if (!issue?.pull_request) {
    throw new Error("Follow-up commands only run on pull request comments.");
  }

  const parsed = parseCommand(event.comment?.body ?? "");
  if (!parsed || parsed.action !== "improve") {
    throw new Error("No /agent improve or /opencode improve command found.");
  }

  const pr = ghJson("api", `repos/${repo()}/pulls/${issue.number}`);
  if (pr.head.repo.full_name !== repo()) {
    throw new Error("Refusing to update a pull request branch from a fork.");
  }

  const prompt = [
    "You are updating an existing agent-created pull request based on reviewer feedback.",
    "",
    "Apply only the requested improvement. Keep the PR branch focused.",
    `Run relevant tests/checks and write a concise verification summary to ${outputPath("followup-verification.md")}.`,
    "",
    "Required skills for this agent run:",
    skillLines(),
    "",
    `Repository: ${process.env.GITHUB_REPOSITORY}`,
    `Pull request: #${issue.number} ${issue.title}`,
    "",
    "Reviewer request:",
    fenced(parsed.remainder || event.comment?.body || ""),
  ].join("\n");

  writeFile("followup-prompt.md", prompt);
  setOutput("prompt", prompt);
  setOutput("head_ref", pr.head.ref);
  setOutput("pr_number", String(issue.number));
}

function postFollowup() {
  const event = readEvent();
  const issue = event.issue;
  const verification = readOptional("followup-verification.md") || "No verification summary was produced.";
  const body = [
    "Updated this PR from the follow-up request.",
    "",
    "Verification:",
    verification.trim(),
  ].join("\n");
  gh("issue", "comment", String(issue.number), "--body", body);
}

async function trace(stage, status) {
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
    console.log("Langfuse secrets not set; skipping trace.");
    return;
  }

  const host = (process.env.LANGFUSE_HOST || "https://cloud.langfuse.com").replace(/\/$/, "");
  const now = BigInt(Date.now()) * 1000000n;
  const ok = ["ok", "success", "succeeded"].includes(String(status).toLowerCase());
  const traceId = idFrom(`${process.env.GITHUB_REPOSITORY}:${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT}`);
  const spanId = idFrom(`${stage}:${status}:${Date.now()}`).slice(0, 16);
  const payload = {
    resourceSpans: [{
      resource: { attributes: otelAttributes({
        "service.name": "github-opencode-agent",
        "deployment.environment": "github-actions",
      }) },
      scopeSpans: [{
        scope: { name: "opencode-agent-glue" },
        spans: [{
          traceId,
          spanId,
          name: `agent.${stage}`,
          kind: 1,
          startTimeUnixNano: String(now - 1000000n),
          endTimeUnixNano: String(now),
          status: { code: ok ? 1 : 2 },
          attributes: otelAttributes({
            "langfuse.trace.name": "GitHub Issue-to-PR Agent",
            "langfuse.session.id": process.env.GITHUB_RUN_ID || "local",
            "langfuse.trace.tags": "github-actions,opencode-agent",
            "github.repository": process.env.GITHUB_REPOSITORY || "",
            "github.workflow": process.env.GITHUB_WORKFLOW || "",
            "github.run_id": process.env.GITHUB_RUN_ID || "",
            "agent.stage": stage,
            "agent.status": status,
          }),
        }],
      }],
    }],
  };

  await postJson(`${host}/api/public/otel/v1/traces`, payload, {
    Authorization: `Basic ${Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString("base64")}`,
  }).catch((error) => {
    console.warn(`Langfuse trace failed: ${error.message}`);
  });
}

function parseCommand(text) {
  const match = COMMAND_PATTERN.exec(text || "");
  if (!match) return null;
  return { tool: match[1].toLowerCase(), action: match[2].toLowerCase(), remainder: (match[3] || "").trim() };
}

function readEvent() {
  const file = process.env.GITHUB_EVENT_PATH;
  if (!file) throw new Error("GITHUB_EVENT_PATH is not set.");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertIssue(issue, phase) {
  if (!issue) throw new Error(`No issue payload available for ${phase}.`);
  if (issue.pull_request && phase !== "follow-up") {
    throw new Error(`Expected an issue payload for ${phase}, but received a pull request payload.`);
  }
}

function assertTrusted(event) {
  const allowed = (process.env.AGENT_ALLOWED_ASSOCIATIONS || "OWNER,MEMBER,COLLABORATOR")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  const association = (event.comment?.author_association || event.issue?.author_association || "").toUpperCase();
  if (!allowed.includes(association)) {
    throw new Error(`User association ${association || "unknown"} is not allowed to run the agent.`);
  }
}

function gh(...args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GH_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_TOKEN },
  }).trim();
}

function ghJson(...args) {
  return JSON.parse(gh(...args));
}

function repo() {
  if (!process.env.GITHUB_REPOSITORY) throw new Error("GITHUB_REPOSITORY is not set.");
  return process.env.GITHUB_REPOSITORY;
}

function ensureLabels(issueNumber, labels) {
  for (const label of labels) {
    try {
      gh("label", "create", label, "--color", "7057ff", "--description", "Managed by the GitHub coding agent");
    } catch {
      // Label probably already exists.
    }
    gh("issue", "edit", String(issueNumber), "--add-label", label);
  }
}

function removeLabels(issueNumber, labels) {
  for (const label of labels) {
    try {
      gh("issue", "edit", String(issueNumber), "--remove-label", label);
    } catch {
      // Label may not be present.
    }
  }
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    console.log(`${name}=${value}`);
    return;
  }
  fs.appendFileSync(outputFile, `${name}<<__agent_output__\n${value}\n__agent_output__\n`);
}

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function writeFile(name, content) {
  fs.writeFileSync(path.join(OUT_DIR, name), content);
}

function outputPath(name) {
  return path.join(OUT_DIR_RELATIVE, name).replaceAll(path.sep, "/");
}

function skillLines() {
  return REQUIRED_SKILLS.map((skill) => `- Use ${skill}.`).join("\n");
}

function readOptional(name) {
  const file = path.join(OUT_DIR, name);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function fenced(value) {
  return `\`\`\`markdown\n${value.replaceAll("```", "`\u200b``")}\n\`\`\``;
}

function stripMarker(value) {
  return value.replace(/<!-- agent-plan:[\s\S]*?-->/g, "").trim();
}

function slug(value) {
  return (value || "work")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "work";
}

function idFrom(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function otelAttributes(values) {
  return Object.entries(values).map(([key, value]) => ({
    key,
    value: { stringValue: String(value) },
  }));
}

function postJson(url, payload, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = https.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...headers,
      },
    }, (response) => {
      let data = "";
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => {
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(data);
        else reject(new Error(`HTTP ${response.statusCode}: ${data}`));
      });
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
