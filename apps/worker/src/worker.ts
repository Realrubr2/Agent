import { loadJobInput } from "./job-input.js";
import { createRunner } from "./runner/runner-factory.js";
import { FileAgentStore } from "./storage/file-store.js";
import { promptHash, summarizePrompt } from "./utils/prompt.js";

export async function runWorker(env = process.env, dependencies = {}) {
  const storeDir = env.AGENT_STORE_DIR || ".tmp/agent-store";
  const store = dependencies.store || new FileAgentStore(storeDir);
  let job;

  try {
    job = await loadJobInput(env, store);
    const now = new Date().toISOString();
    const session = await store.upsertSessionForJob(job, now);
    const attempt = session.attemptCount;
    const jobRecord = await store.createJobAttempt(job, attempt, now);

    await store.appendTranscript(job.sessionId, {
      jobId: job.jobId,
      attempt,
      role: "system",
      type: "job_loaded",
      message: `Loaded job ${job.jobId} for ${job.repository.fullName}`,
    });
    await store.appendTranscript(job.sessionId, {
      jobId: job.jobId,
      attempt,
      role: "system",
      type: session.attemptCount === 1 ? "session_created" : "session_loaded",
      message: `Session ${job.sessionId} attempt ${attempt}`,
    });
    await store.appendTranscript(job.sessionId, {
      jobId: job.jobId,
      attempt,
      role: "user",
      type: "prompt_received",
      message: summarizePrompt(job.prompt),
    });

    await store.updateJob(job.jobId, {
      status: "running",
      startedAt: now,
    });
    await store.updateSession(job.sessionId, {
      status: "running",
      updatedAt: now,
    });

    const runner = dependencies.runner || createRunner(job, { env, store, dependencies });
    await store.appendTranscript(job.sessionId, {
      jobId: job.jobId,
      attempt,
      role: "assistant",
      type: `${runner.kind}_runner_started`,
      message: `${runner.label || runner.kind} runner started.`,
    });
    const result = await runner.run(job, { attempt });
    if (result.stdout) console.log(result.stdout);

    await store.appendTranscript(job.sessionId, {
      jobId: job.jobId,
      attempt,
      role: "assistant",
      type: `${runner.kind}_runner_completed`,
      message: result.summary,
    });

    const finishedAt = new Date().toISOString();
    await store.updateJob(job.jobId, {
      status: "succeeded",
      finishedAt,
      result,
    });
    await store.updateSession(job.sessionId, {
      status: "succeeded",
      updatedAt: finishedAt,
      lastJobId: job.jobId,
      lastPromptHash: promptHash(job.prompt),
      lastPromptSummary: summarizePrompt(job.prompt),
      lastResult: result,
      opencode: result.opencode || undefined,
    });
    await store.appendTranscript(job.sessionId, {
      jobId: job.jobId,
      attempt,
      role: "system",
      type: "result_stored",
      message: `${runner.label || runner.kind} result stored.`,
    });

    return {
      job,
      jobRecord,
      result,
      sessionId: job.sessionId,
      jobId: job.jobId,
      attempt,
      status: "succeeded",
    };
  } catch (error) {
    const failedJob = job || error?.partialJob;

    if (failedJob?.jobId && failedJob?.sessionId) {
      const failedAt = new Date().toISOString();
      const safeMessage = error?.message || String(error);
      await store.recordFailure(failedJob, safeMessage, failedAt);
      await store.appendTranscript(failedJob.sessionId, {
        jobId: failedJob.jobId,
        attempt: failedJob.attempt || 1,
        role: "system",
        type: "failed",
        message: safeMessage,
      });
    }

    throw error;
  }
}
