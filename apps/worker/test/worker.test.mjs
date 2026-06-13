import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runWorker } from "../dist/worker.js";
import { validateJob } from "../dist/job-schema.js";
import { FileAgentStore } from "../dist/storage/file-store.js";
import { EchoRunner } from "../dist/runner/echo-runner.js";
import { createRunner } from "../dist/runner/runner-factory.js";
import { RepositoryWorkflow } from "../dist/services/repository-workflow.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("job schema validation accepts a complete payload", () => {
  const job = validateJob(sampleJob());
  assert.equal(job.jobId, "job_local_001");
  assert.equal(job.sessionId, "session_demo_001");
  assert.equal(job.repository.fullName, "realrubr2/Server");
  assert.equal(job.target.action, "run");
});

test("job schema preserves explicit target action", () => {
  const job = validateJob(sampleJob({
    jobId: "job_approve_abc123",
    target: {
      action: "approve",
      kind: "issue",
      issueNumber: 123,
      pullRequestNumber: null,
      commentId: 456,
      actor: "ramon",
      triggerText: "/webhook-agent approve",
    },
  }));

  assert.equal(job.target.action, "approve");
});

test("job schema validation rejects required missing fields", () => {
  assert.throws(
    () => validateJob({ repository: {}, target: {}, agent: {} }),
    /jobId is required.*sessionId is required.*prompt is required.*repository\.fullName is required/,
  );
});

test("file store creates a session and appends transcript entries", async () => {
  const storeDir = await tempDir();
  const store = new FileAgentStore(storeDir);
  const job = validateJob(sampleJob());

  const session = await store.upsertSessionForJob(job, "2026-06-12T00:00:00.000Z");
  await store.createJobAttempt(job, session.attemptCount, "2026-06-12T00:00:00.000Z");
  await store.appendTranscript(job.sessionId, {
    jobId: job.jobId,
    attempt: 1,
    type: "test",
    message: "hello",
  });
  await store.appendTranscript(job.sessionId, {
    jobId: job.jobId,
    attempt: 1,
    type: "test",
    message: "again",
  });

  const storedSession = await readJson(path.join(storeDir, "sessions", "session_demo_001.json"));
  const transcript = await readJsonl(path.join(storeDir, "transcripts", "session_demo_001.jsonl"));

  assert.equal(storedSession.attemptCount, 1);
  assert.equal(transcript.length, 2);
  assert.equal(transcript[0].sequence, 1);
  assert.equal(transcript[1].sequence, 2);
});

test("file store assigns stable sequence numbers for concurrent transcript appends", async () => {
  const storeDir = await tempDir();
  const store = new FileAgentStore(storeDir);
  const job = validateJob(sampleJob());
  await store.upsertSessionForJob(job, "2026-06-12T00:00:00.000Z");

  await Promise.all(Array.from({ length: 12 }, (_, index) => store.appendTranscript(job.sessionId, {
    jobId: job.jobId,
    attempt: 1,
    type: "concurrent",
    message: `entry ${index}`,
  })));

  const transcript = await readJsonl(path.join(storeDir, "transcripts", "session_demo_001.jsonl"));
  assert.deepEqual(transcript.map((entry) => entry.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test("worker reuses same session id and appends a second attempt", async () => {
  const storeDir = await tempDir();
  const firstJob = await writeJobFile(storeDir, sampleJob());
  const secondJob = await writeJobFile(storeDir, sampleJob({
    jobId: "job_local_002",
    prompt: "Second prompt for the same session.",
  }), "job-2.json");

  await runWorker({
    JOB_FILE: firstJob,
    AGENT_STORE_DIR: storeDir,
  });
  await runWorker({
    JOB_FILE: secondJob,
    AGENT_STORE_DIR: storeDir,
  });

  const session = await readJson(path.join(storeDir, "sessions", "session_demo_001.json"));
  const transcript = await readJsonl(path.join(storeDir, "transcripts", "session_demo_001.jsonl"));

  assert.equal(session.attemptCount, 2);
  assert.equal(session.firstJobId, "job_local_001");
  assert.equal(session.lastJobId, "job_local_002");
  assert.equal(session.status, "succeeded");
  assert.ok(transcript.some((entry) => entry.jobId === "job_local_001"));
  assert.ok(transcript.some((entry) => entry.jobId === "job_local_002"));
});

test("same repository with different session ids updates repo index with both sessions", async () => {
  const storeDir = await tempDir();
  const firstJob = await writeJobFile(storeDir, sampleJob());
  const secondJob = await writeJobFile(storeDir, sampleJob({
    jobId: "job_local_003",
    sessionId: "session_demo_002",
  }), "job-3.json");

  await runWorker({ JOB_FILE: firstJob, AGENT_STORE_DIR: storeDir });
  await runWorker({ JOB_FILE: secondJob, AGENT_STORE_DIR: storeDir });

  const repoIndex = await readJson(path.join(storeDir, "repos", "realrubr2__Server.json"));
  assert.deepEqual(repoIndex.sessions, ["session_demo_001", "session_demo_002"]);
});

test("echo runner returns structured prompt metadata", async () => {
  const result = await new EchoRunner().run(validateJob(sampleJob()), { attempt: 7 });

  assert.equal(result.kind, "echo");
  assert.equal(result.sessionId, "session_demo_001");
  assert.equal(result.jobId, "job_local_001");
  assert.equal(result.attempt, 7);
  assert.equal(result.repositoryFullName, "realrubr2/Server");
  assert.match(result.stdout, /Echo this prompt/);
  assert.equal(result.promptHash.length, 64);
});

test("runner factory selects echo runner", () => {
  const runner = createRunner(validateJob(sampleJob()));
  assert.equal(runner.kind, "echo");
});

test("repository workflow prepares, commits, pushes, and creates PR for approve", async () => {
  const storeDir = await tempDir();
  const store = new FileAgentStore(storeDir);
  const calls = [];
  const workflow = new RepositoryWorkflow({
    env: {
      GITHUB_TOKEN: "github_pat_test",
      AGENT_WORKSPACE_DIR: path.join(storeDir, "workspaces"),
    },
    store,
    execFile: async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      if (args[0] === "status") return { stdout: " M index.js\n", stderr: "" };
      return { stdout: "", stderr: "" };
    },
    fetch: async (url, options) => {
      calls.push({ url: String(url), method: options.method || "GET", body: options.body });
      return jsonResponse({ number: 12, html_url: "https://github.com/realrubr2/Server/pull/12" });
    },
  });
  const job = validateJob(sampleJob({
    jobId: "job_approve_abc123",
    target: {
      action: "approve",
      kind: "issue",
      issueNumber: 123,
      pullRequestNumber: null,
      commentId: 456,
      actor: "ramon",
      triggerText: "/webhook-agent approve",
    },
  }));

  await workflow.prepare(job, { attempt: 1 });
  const result = await workflow.finalize(job, { summary: "done", stdout: "runner output" }, { attempt: 1 });

  assert.match(job.agent.workspaceDir, /repo$/);
  assert.ok(calls.some((call) => call.args?.[0] === "clone"));
  assert.ok(calls.some((call) => call.args?.[0] === "commit"));
  assert.ok(calls.some((call) => call.args?.[0] === "push"));
  assert.ok(calls.some((call) => call.url?.endsWith("/repos/realrubr2/Server/pulls") && call.method === "POST"));
  assert.equal(result.git.pullRequestNumber, 12);
  assert.match(result.stdout, /pullRequest=https:\/\/github.com\/realrubr2\/Server\/pull\/12/);
});

test("JOB_ID can load an existing local job record", async () => {
  const storeDir = await tempDir();
  const jobFile = await writeJobFile(storeDir, sampleJob());

  await runWorker({ JOB_FILE: jobFile, AGENT_STORE_DIR: storeDir });
  await runWorker({ JOB_ID: "job_local_001", AGENT_STORE_DIR: storeDir });

  const session = await readJson(path.join(storeDir, "sessions", "session_demo_001.json"));
  assert.equal(session.attemptCount, 2);
});

test("invalid job with ids records failure", async () => {
  const storeDir = await tempDir();
  const invalidJobFile = await writeRawJobFile(storeDir, {
    jobId: "job_bad_001",
    sessionId: "session_bad_001",
    repository: { fullName: "realrubr2/Server" },
    target: {},
    agent: {},
  }, "bad.json");

  await assert.rejects(
    () => runWorker({ JOB_FILE: invalidJobFile, AGENT_STORE_DIR: storeDir }),
    /prompt is required/,
  );

  const session = await readJson(path.join(storeDir, "sessions", "session_bad_001.json"));
  const job = await readJson(path.join(storeDir, "jobs", "job_bad_001.json"));
  const transcript = await readJsonl(path.join(storeDir, "transcripts", "session_bad_001.jsonl"));

  assert.equal(session.status, "failed");
  assert.equal(job.status, "failed");
  assert.equal(transcript.at(-1).type, "failed");
});

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "agent-worker-test-"));
}

async function writeJobFile(storeDir, value, name = "job.json") {
  return writeRawJobFile(storeDir, value, name);
}

async function writeRawJobFile(storeDir, value, name) {
  const inputDir = path.join(storeDir, "input");
  await fs.mkdir(inputDir, { recursive: true });
  const filePath = path.join(inputDir, name);
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readJsonl(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return content.trim().split("\n").map((line) => JSON.parse(line));
}

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(value);
    },
  };
}

function sampleJob(overrides = {}) {
  const agent = {
    mode: "echo",
    model: "local/echo",
    timeoutSeconds: 60,
    ...(overrides.agent || {}),
  };

  return {
    jobId: "job_local_001",
    sessionId: "session_demo_001",
    attempt: 1,
    prompt: "Echo this prompt for now.",
    repository: {
      owner: "realrubr2",
      name: "Server",
      fullName: "realrubr2/Server",
      cloneUrl: "https://github.com/realrubr2/Server.git",
      defaultBranch: "main",
    },
    target: {
      kind: "issue",
      issueNumber: 123,
      pullRequestNumber: null,
      commentId: 456,
      actor: "ramon",
      triggerText: "@agent fix this",
    },
    agent,
    ...overrides,
  };
}

export {
  readJson,
  readJsonl,
  sampleJob,
  tempDir,
  writeJobFile,
  writeRawJobFile,
};
