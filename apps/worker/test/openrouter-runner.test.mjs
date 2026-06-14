import assert from "node:assert/strict";
import test from "node:test";
import { validateJob } from "../dist/job-schema.js";
import { createRunner } from "../dist/runner/runner-factory.js";
import { OpenRouterRunner } from "../dist/runner/openrouter-runner.js";

test("runner factory selects openrouter runner", () => {
  const runner = createRunner(validateJob(sampleJob({
    agent: {
      mode: "openrouter",
      model: "openrouter/z-ai/glm-4.7-flash",
    },
  })));

  assert.equal(runner.kind, "openrouter");
});

test("openrouter runner sends chat completion request and returns content", async () => {
  const requests = [];
  const runner = new OpenRouterRunner({
    env: {
      OPENROUTER_API_KEY: "sk-or-test",
      OPENROUTER_HTTP_REFERER: "https://github.com/realrubr2/Agent",
      OPENROUTER_APP_TITLE: "Agent Test",
    },
    fetch: async (url, options) => {
      requests.push({
        url: String(url),
        headers: options.headers,
        body: JSON.parse(options.body),
      });
      return response({
        id: "gen_test",
        choices: [{
          message: {
            content: "## Plan\n\n- Build the thing\n- Test it",
          },
        }],
      });
    },
  });
  const job = validateJob(sampleJob({
    agent: {
      mode: "openrouter",
      model: "openrouter/z-ai/glm-4.7-flash",
    },
  }));

  const result = await runner.run(job, { attempt: 2 });

  assert.equal(result.kind, "openrouter");
  assert.match(result.stdout, /Build the thing/);
  assert.equal(requests[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(requests[0].body.model, "z-ai/glm-4.7-flash");
  assert.equal(requests[0].body.messages.at(-1).content, "Plan this issue.");
});

test("openrouter runner rejects approve jobs", async () => {
  const runner = new OpenRouterRunner({
    env: {
      OPENROUTER_API_KEY: "sk-or-test",
    },
    fetch: async () => response({}),
  });
  const job = validateJob(sampleJob({
    jobId: "job_approve_001",
    target: {
      action: "approve",
      kind: "issue",
      issueNumber: 8,
      pullRequestNumber: null,
      commentId: 42,
      actor: "ramon",
      triggerText: "/webhook-agent approve",
    },
    agent: {
      mode: "openrouter",
      model: "openrouter/z-ai/glm-4.7-flash",
    },
  }));

  await assert.rejects(() => runner.run(job), /supports plan jobs only/);
});

function sampleJob(overrides = {}) {
  const agent = {
    mode: "echo",
    model: "local/echo",
    timeoutSeconds: 60,
    ...(overrides.agent || {}),
  };

  return {
    jobId: "job_plan_001",
    sessionId: "session_demo_001",
    attempt: 1,
    prompt: "Plan this issue.",
    repository: {
      owner: "realrubr2",
      name: "Server",
      fullName: "realrubr2/Server",
      cloneUrl: "https://github.com/realrubr2/Server.git",
      defaultBranch: "main",
    },
    target: {
      action: "plan",
      kind: "issue",
      issueNumber: 123,
      pullRequestNumber: null,
      commentId: 456,
      actor: "ramon",
      triggerText: "/webhook-agent plan",
      ...(overrides.target || {}),
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
