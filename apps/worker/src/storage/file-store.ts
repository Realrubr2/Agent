import fs from "node:fs/promises";
import path from "node:path";
import { promptHash, summarizePrompt } from "../utils/prompt.js";

export class FileAgentStore {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
    this.appendQueues = new Map();
  }

  async loadJobInput(jobId) {
    const job = await readJsonIfExists(this.jobPath(jobId));
    return job?.input || null;
  }

  async upsertSessionForJob(job, timestamp) {
    await this.ensureDirs();
    const existing = await readJsonIfExists(this.sessionPath(job.sessionId));
    const attemptCount = (existing?.attemptCount || 0) + 1;
    const attempt = {
      attempt: attemptCount,
      jobId: job.jobId,
      startedAt: timestamp,
      status: "running",
    };
    const session = {
      sessionId: job.sessionId,
      firstJobId: existing?.firstJobId || job.jobId,
      lastJobId: job.jobId,
      repositoryFullName: job.repository.fullName,
      target: {
        kind: job.target.kind,
        issueNumber: job.target.issueNumber,
        pullRequestNumber: job.target.pullRequestNumber,
      },
      status: "running",
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
      attemptCount,
      attempts: [...(existing?.attempts || []), attempt],
      lastPromptHash: promptHash(job.prompt),
      lastPromptSummary: summarizePrompt(job.prompt),
      lastResult: existing?.lastResult || null,
    };

    await writeJson(this.sessionPath(job.sessionId), session);
    await this.updateRepoIndex(job.repository.fullName, job.sessionId, timestamp);
    return session;
  }

  async createJobAttempt(job, attempt, timestamp) {
    await this.ensureDirs();
    const record = {
      jobId: job.jobId,
      sessionId: job.sessionId,
      attempt,
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
      repositoryFullName: job.repository.fullName,
      input: job.raw,
    };
    await writeJson(this.jobPath(job.jobId), record);
    return record;
  }

  async updateJob(jobId, patch) {
    const existing = await readJsonIfExists(this.jobPath(jobId));
    if (!existing) {
      throw new Error(`Cannot update missing job ${jobId}`);
    }
    const updated = {
      ...existing,
      ...patch,
      updatedAt: patch.updatedAt || new Date().toISOString(),
    };
    await writeJson(this.jobPath(jobId), updated);
    return updated;
  }

  async updateSession(sessionId, patch) {
    const existing = await readJsonIfExists(this.sessionPath(sessionId));
    if (!existing) {
      throw new Error(`Cannot update missing session ${sessionId}`);
    }
    const updated = {
      ...existing,
      ...patch,
      updatedAt: patch.updatedAt || new Date().toISOString(),
      attempts: markLatestAttempt(existing.attempts || [], patch.status, patch.updatedAt),
    };
    await writeJson(this.sessionPath(sessionId), updated);
    return updated;
  }

  async appendTranscript(sessionId, entry) {
    const previous = this.appendQueues.get(sessionId) || Promise.resolve();
    const next = previous.then(() => this.appendTranscriptUnlocked(sessionId, entry));
    this.appendQueues.set(sessionId, next.catch(() => {}));
    return await next;
  }

  async appendTranscriptUnlocked(sessionId, entry) {
    await this.ensureDirs();
    const transcriptPath = this.transcriptPath(sessionId);
    const sequence = await nextSequence(transcriptPath);
    const record = {
      sessionId,
      jobId: entry.jobId,
      attempt: entry.attempt,
      sequence,
      timestamp: entry.timestamp || new Date().toISOString(),
      role: entry.role || "system",
      type: entry.type || "message",
      message: entry.message || "",
    };
    await fs.appendFile(transcriptPath, `${JSON.stringify(record)}\n`, "utf8");
    return record;
  }

  async recordFailure(job, message, timestamp) {
    await this.ensureDirs();
    const existingSession = await readJsonIfExists(this.sessionPath(job.sessionId));

    if (existingSession) {
      await this.updateSession(job.sessionId, {
        status: "failed",
        updatedAt: timestamp,
        failure: {
          message,
          failedAt: timestamp,
        },
      });
    } else {
      const session = {
        sessionId: job.sessionId,
        firstJobId: job.jobId,
        lastJobId: job.jobId,
        repositoryFullName: job.repository?.fullName || "unknown",
        target: job.target || {},
        status: "failed",
        createdAt: timestamp,
        updatedAt: timestamp,
        attemptCount: 1,
        attempts: [{
          attempt: 1,
          jobId: job.jobId,
          startedAt: timestamp,
          finishedAt: timestamp,
          status: "failed",
        }],
        failure: {
          message,
          failedAt: timestamp,
        },
      };
      await writeJson(this.sessionPath(job.sessionId), session);
    }

    const existingJob = await readJsonIfExists(this.jobPath(job.jobId));
    await writeJson(this.jobPath(job.jobId), {
      ...(existingJob || {
        jobId: job.jobId,
        sessionId: job.sessionId,
        input: job.raw || job,
        createdAt: timestamp,
      }),
      status: "failed",
      updatedAt: timestamp,
      failure: {
        message,
        failedAt: timestamp,
      },
    });
  }

  async updateRepoIndex(repositoryFullName, sessionId, timestamp) {
    const repoPath = this.repoPath(repositoryFullName);
    const existing = await readJsonIfExists(repoPath);
    const sessions = new Set(existing?.sessions || []);
    sessions.add(sessionId);
    const [owner, name] = repositoryFullName.split("/");

    await writeJson(repoPath, {
      repositoryFullName,
      owner,
      name,
      sessions: [...sessions].sort(),
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    });
  }

  async ensureDirs() {
    await Promise.all([
      fs.mkdir(path.join(this.rootDir, "sessions"), { recursive: true }),
      fs.mkdir(path.join(this.rootDir, "jobs"), { recursive: true }),
      fs.mkdir(path.join(this.rootDir, "transcripts"), { recursive: true }),
      fs.mkdir(path.join(this.rootDir, "repos"), { recursive: true }),
    ]);
  }

  sessionPath(sessionId) {
    return path.join(this.rootDir, "sessions", `${safeFileName(sessionId)}.json`);
  }

  jobPath(jobId) {
    return path.join(this.rootDir, "jobs", `${safeFileName(jobId)}.json`);
  }

  transcriptPath(sessionId) {
    return path.join(this.rootDir, "transcripts", `${safeFileName(sessionId)}.jsonl`);
  }

  repoPath(repositoryFullName) {
    return path.join(this.rootDir, "repos", `${safeFileName(repositoryFullName.replace("/", "__"))}.json`);
  }
}

export async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function markLatestAttempt(attempts, status, timestamp) {
  if (!status || attempts.length === 0) return attempts;
  return attempts.map((attempt, index) => {
    if (index !== attempts.length - 1) return attempt;
    return {
      ...attempt,
      status,
      finishedAt: ["succeeded", "failed"].includes(status) ? timestamp || new Date().toISOString() : attempt.finishedAt,
    };
  });
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function nextSequence(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    if (!content.trim()) return 1;
    return content.trimEnd().split("\n").length + 1;
  } catch (error) {
    if (error.code === "ENOENT") return 1;
    throw error;
  }
}

function safeFileName(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
}
