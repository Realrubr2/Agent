import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runWorker } from "../dist/worker.js";
import { validateJob } from "../dist/job-schema.js";
import { createRunner } from "../dist/runner/runner-factory.js";
import { OpencodeApiClient } from "../dist/services/opencode-api-client.js";
import { OpencodeProcessManager } from "../dist/services/opencode-process-manager.js";
import { DisabledLangfuseSink } from "../dist/services/langfuse-sink.js";
import { redactSecrets } from "../dist/utils/redact.js";

test("job schema applies opencode defaults", () => {
  const job = validateJob(sampleJob({
    agent: {
      mode: "opencode-api",
      model: "openrouter/test-model",
      timeoutSeconds: 90,
    },
  }));

  assert.equal(job.agent.mode, "opencode-api");
  assert.equal(job.agent.agentName, "build");
  assert.equal(job.agent.opencode.startServer, true);
  assert.equal(job.agent.opencode.hostname, "127.0.0.1");
  assert.equal(job.agent.opencode.port, 0);
  assert.equal(job.agent.langfuse.traceId, "session_demo_001");
});

test("runner factory selects opencode runner", () => {
  const runner = createRunner(validateJob(sampleJob({
    agent: {
      mode: "opencode-api",
      model: "local/fake",
    },
  })));

  assert.equal(runner.kind, "opencode");
});

test("runner factory rejects unknown mode", () => {
  assert.throws(
    () => createRunner(validateJob(sampleJob({ agent: { mode: "mystery" } }))),
    /Unsupported agent mode/,
  );
});

test("redacts common secrets from logs", () => {
  const text = redactSecrets("GITHUB_TOKEN=ghp_abc123 OPENAI_API_KEY=sk-test https://x:y@example.com/repo.git");
  assert.doesNotMatch(text, /ghp_abc123/);
  assert.doesNotMatch(text, /sk-test/);
  assert.doesNotMatch(text, /x:y/);
});

test("opencode api client talks to fake server", async () => {
  const fakeFetch = createFakeFetch();
  const client = new OpencodeApiClient({ baseUrl: "http://fake-opencode.local", fetch: fakeFetch.fetch });
  const health = await client.health();
  const doc = await client.docSummary();
  const session = await client.createSession(validateJob(sampleJob({ agent: { mode: "opencode-api" } })));
  const events = await client.sendPrompt(session.id, validateJob(sampleJob({ agent: { mode: "opencode-api" } })));

  assert.equal(health.healthy, true);
  assert.equal(doc.pathCount, 4);
  assert.equal(session.id, "ses_fake_001");
  assert.equal(events.at(-1).type, "assistant_final");
  assert.deepEqual(fakeFetch.requests.map((request) => request.pathname), [
    "/global/health",
    "/doc",
    "/session",
    "/session/ses_fake_001/message",
  ]);
  assert.deepEqual(fakeFetch.requests.at(-1).body.model, {
    providerID: "local",
    modelID: "echo",
  });
  assert.deepEqual(fakeFetch.requests.at(-1).body.parts, [
    {
      type: "text",
      text: "Echo this prompt for now.",
    },
  ]);
});

test("worker opencode-api mode persists fake api events and metadata", async () => {
  const storeDir = await tempDir();
  const jobFile = await writeJobFile(storeDir, sampleJob({
    jobId: "job_opencode_fake_001",
    sessionId: "session_opencode_fake_001",
    prompt: "Fake opencode prompt.",
    agent: {
      mode: "opencode-api",
      model: "local/fake",
      opencode: {
        apiBaseUrl: "http://fake-opencode.local",
        startServer: false,
      },
      langfuse: {
        enabled: false,
        tags: ["test"],
      },
    },
  }));
  const fakeFetch = createFakeFetch();
  const apiClient = new OpencodeApiClient({
    baseUrl: "http://fake-opencode.local",
    fetch: fakeFetch.fetch,
  });

  const result = await runWorker({
    JOB_FILE: jobFile,
    AGENT_STORE_DIR: storeDir,
  }, {
    apiClient,
  });

  const session = await readJson(path.join(storeDir, "sessions", "session_opencode_fake_001.json"));
  const transcript = await readJsonl(path.join(storeDir, "transcripts", "session_opencode_fake_001.jsonl"));

  assert.equal(result.status, "succeeded");
  assert.equal(session.lastResult.opencodeSessionId, "ses_fake_001");
  assert.equal(session.opencode.sessionId, "ses_fake_001");
  assert.ok(transcript.some((entry) => entry.type === "assistant_final"));
  assert.ok(transcript.some((entry) => entry.type === "opencode_api_doc_loaded"));
});

test("worker opencode-server-check starts process manager and stores server metadata", async () => {
  const storeDir = await tempDir();
  const jobFile = await writeJobFile(storeDir, sampleJob({
    jobId: "job_server_check_001",
    sessionId: "session_server_check_001",
    agent: {
      mode: "opencode-server-check",
      model: "local/server-check",
    },
  }));
  const processManager = {
    started: false,
    stopped: false,
    async start() {
      this.started = true;
      return {
        baseUrl: "http://127.0.0.1:9999",
        stop: async () => {
          this.stopped = true;
        },
      };
    },
  };
  const apiClient = {
    async health() {
      return { healthy: true, version: "fake-version" };
    },
    async docSummary() {
      return { pathCount: 3, paths: ["/doc", "/global/health", "/session"] };
    },
  };
  const langfuseSink = new DisabledLangfuseSink();

  const result = await runWorker({
    JOB_FILE: jobFile,
    AGENT_STORE_DIR: storeDir,
  }, {
    processManager,
    apiClient,
    langfuseSink,
  });

  const session = await readJson(path.join(storeDir, "sessions", "session_server_check_001.json"));
  const transcript = await readJsonl(path.join(storeDir, "transcripts", "session_server_check_001.jsonl"));

  assert.equal(processManager.started, true);
  assert.equal(processManager.stopped, true);
  assert.equal(result.result.opencode.version, "fake-version");
  assert.equal(session.opencode.version, "fake-version");
  assert.ok(transcript.some((entry) => entry.type === "opencode_server_ready"));
  assert.ok(langfuseSink.events.some((event) => event.type === "finish"));
});

test("opencode process manager builds a writable local serve environment", async () => {
  const storeDir = await tempDir();
  const manager = new OpencodeProcessManager({
    env: { PATH: "/fake/bin" },
  });
  const job = validateJob(sampleJob({
    sessionId: "session_process_manager_001",
    agent: {
      mode: "opencode-server-check",
      timeoutSeconds: 10,
      workspaceDir: path.join(storeDir, "workspace"),
      opencode: {
        command: "opencode",
        hostname: "127.0.0.1",
        port: 49494,
      },
    },
  }));

  const launch = await manager.prepareLaunch(job, { attempt: 1 });

  assert.equal(launch.baseUrl, "http://127.0.0.1:49494");
  assert.deepEqual(launch.args.slice(0, 5), ["serve", "--hostname", "127.0.0.1", "--port", "49494"]);
  assert.match(launch.env.HOME, /workspace/);
  assert.match(launch.env.XDG_DATA_HOME, /workspace/);
  assert.match(launch.env.XDG_CONFIG_HOME, /workspace/);
});

function createFakeFetch() {
  const requests = [];
  const fakeFetch = async (input, options = {}) => {
    const url = new URL(String(input));
    requests.push({
      method: options.method || "GET",
      pathname: url.pathname,
      body: options.body ? JSON.parse(options.body) : null,
    });

    if (url.pathname === "/global/health") {
      return response({ healthy: true, version: "fake-opencode" });
    }
    if (url.pathname === "/doc") {
      return response({
        info: { title: "opencode", version: "fake" },
        paths: {
          "/doc": {},
          "/global/health": {},
          "/session": {},
          "/session/{sessionID}/message": {},
        },
      });
    }
    if (url.pathname === "/session") {
      return response({ id: "ses_fake_001" });
    }
    if (url.pathname === "/session/ses_fake_001/message") {
      return response({
        events: [
          { type: "assistant_delta", message: "Working" },
          { type: "tool_completed", name: "fake-tool", message: "done" },
          { type: "assistant_final", message: "Fake opencode result" },
        ],
      });
    }
    return response({ error: "not found" }, 404);
  };
  return { fetch: fakeFetch, requests };
}

async function tempDir() {
  return await fs.mkdtemp(path.join("/tmp", "agent-worker-opencode-test-"));
}

async function writeJobFile(storeDir, value, name = "job.json") {
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

function response(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(value),
  };
}
