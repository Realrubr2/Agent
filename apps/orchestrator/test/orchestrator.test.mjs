import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseCommand } from "../dist/commands.js";
import { loadConfig } from "../dist/config.js";
import { buildWorkerJob, extractLatestPlan } from "../dist/jobs.js";
import { handleGitHubEvent, verifySignature } from "../dist/webhook.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("parseCommand finds agent and opencode commands", () => {
  assert.deepEqual(parseCommand("/agent plan"), {
    tool: "agent",
    action: "plan",
    remainder: "",
  });
  assert.deepEqual(parseCommand("/opencode improve add an empty-state test"), {
    tool: "opencode",
    action: "improve",
    remainder: "add an empty-state test",
  });
  assert.deepEqual(parseCommand("please review\n/agent plan"), {
    tool: "agent",
    action: "plan",
    remainder: "",
  });
  assert.equal(parseCommand("nothing to do"), null);
  assert.equal(parseCommand("worker echoed /agent plan inside output"), null);
});

test("parseCommand can use custom command prefixes", () => {
  assert.deepEqual(parseCommand("/webhook-agent plan", ["webhook-agent"]), {
    tool: "webhook-agent",
    action: "plan",
    remainder: "",
  });
  assert.equal(parseCommand("/agent plan", ["webhook-agent"]), null);
});

test("verifySignature validates GitHub sha256 signatures", () => {
  const body = JSON.stringify({ ok: true });
  const signature = `sha256=${crypto.createHmac("sha256", "secret").update(body).digest("hex")}`;

  assert.equal(verifySignature(body, signature, "secret"), true);
  assert.equal(verifySignature(body, signature, "wrong"), false);
  assert.equal(verifySignature(body, "", "secret"), false);
  assert.equal(verifySignature(body, "", ""), true);
});

test("extractLatestPlan strips marker from newest plan comment", () => {
  const plan = extractLatestPlan([
    { body: "not a plan" },
    { body: "First plan\n<!-- agent-plan:{\"id\":1} -->" },
    { body: "Latest plan\n<!-- agent-plan:{\"id\":2} -->" },
  ]);

  assert.equal(plan, "Latest plan");
});

test("buildWorkerJob creates normalized worker input", async () => {
  const payload = await samplePayload();
  const config = loadConfig({
    ORCHESTRATOR_AGENT_MODE: "echo",
    ORCHESTRATOR_AGENT_MODEL: "local/echo",
    AGENT_ALLOWED_ASSOCIATIONS: "OWNER",
    ORCHESTRATOR_COMMAND_PREFIXES: "webhook-agent",
  });
  const job = buildWorkerJob({
    event: payload,
    command: parseCommand(payload.comment.body, config.commandPrefixes),
    config,
  });

  assert.match(job.jobId, /^job_plan_/);
  assert.equal(job.repository.fullName, "realrubr2/Server");
  assert.equal(job.target.issueNumber, 123);
  assert.equal(job.agent.mode, "echo");
  assert.match(job.prompt, /planning phase/);
});

test("handleGitHubEvent launches worker for trusted plan command", async () => {
  const payload = await samplePayload();
  const github = new FakeGitHub();
  const launcher = new FakeLauncher();
  const config = loadConfig({
    ORCHESTRATOR_REPOSITORIES: "realrubr2/Server",
    AGENT_ALLOWED_ASSOCIATIONS: "OWNER",
    ORCHESTRATOR_COMMAND_PREFIXES: "webhook-agent",
    ORCHESTRATOR_WORKER_LAUNCH_MODE: "dry-run",
  });

  const result = await handleGitHubEvent({
    eventName: "issue_comment",
    payload,
    config,
    github,
    launcher,
    logger: silentLogger(),
  });

  assert.equal(result.accepted, true);
  assert.equal(launcher.jobs.length, 1);
  assert.equal(launcher.jobs[0].repository.fullName, "realrubr2/Server");
  assert.equal(github.createdComments.length, 2);
  assert.match(github.createdComments[0].body, /request accepted/);
  assert.match(github.createdComments[0].body, /<!-- agent-orchestrator -->/);
  assert.match(github.createdComments[1].body, /worker finished/);
});

test("handleGitHubEvent ignores orchestrator comments", async () => {
  const payload = await samplePayload({
    comment: {
      body: [
        "Agent plan worker finished with `succeeded`.",
        "",
        "```text",
        "Planning comment:",
        "/webhook-agent plan",
        "```",
        "",
        "<!-- agent-orchestrator -->",
      ].join("\n"),
    },
  });
  const github = new FakeGitHub();
  const launcher = new FakeLauncher();
  const config = loadConfig({
    ORCHESTRATOR_REPOSITORIES: "realrubr2/Server",
    AGENT_ALLOWED_ASSOCIATIONS: "OWNER",
    ORCHESTRATOR_COMMAND_PREFIXES: "webhook-agent",
  });

  const result = await handleGitHubEvent({
    eventName: "issue_comment",
    payload,
    config,
    github,
    launcher,
    logger: silentLogger(),
  });

  assert.equal(result.reason, "orchestrator comment");
  assert.equal(launcher.jobs.length, 0);
  assert.equal(github.createdComments.length, 0);
});

test("handleGitHubEvent rejects untrusted actor without launching worker", async () => {
  const payload = await samplePayload({
    comment: { author_association: "CONTRIBUTOR" },
  });
  const github = new FakeGitHub();
  const launcher = new FakeLauncher();
  const config = loadConfig({
    ORCHESTRATOR_REPOSITORIES: "realrubr2/Server",
    AGENT_ALLOWED_ASSOCIATIONS: "OWNER",
    ORCHESTRATOR_COMMAND_PREFIXES: "webhook-agent",
  });

  const result = await handleGitHubEvent({
    eventName: "issue_comment",
    payload,
    config,
    github,
    launcher,
    logger: silentLogger(),
  });

  assert.equal(result.reason, "untrusted_actor");
  assert.equal(launcher.jobs.length, 0);
  assert.equal(github.createdComments.length, 1);
  assert.match(github.createdComments[0].body, /rejected/);
});

class FakeGitHub {
  constructor() {
    this.createdComments = [];
    this.issueComments = [];
  }

  async createIssueComment(repositoryFullName, issueNumber, body) {
    this.createdComments.push({ repositoryFullName, issueNumber, body });
    return { id: this.createdComments.length };
  }

  async listIssueComments() {
    return this.issueComments;
  }
}

class FakeLauncher {
  constructor() {
    this.jobs = [];
  }

  async launch(job) {
    this.jobs.push(job);
    return {
      status: "succeeded",
      code: 0,
      signal: null,
      stdout: `jobId=${job.jobId}`,
      stderr: "",
    };
  }
}

async function samplePayload(overrides = {}) {
  const payload = JSON.parse(await fs.readFile(path.join(appRoot, "examples", "issue-comment-plan.json"), "utf8"));
  return merge(payload, overrides);
}

function merge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      target[key] = merge(target[key] || {}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function silentLogger() {
  return { log() {}, warn() {}, error() {} };
}
