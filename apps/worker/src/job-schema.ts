export function validateJob(value) {
  const errors = [];
  const job = value && typeof value === "object" ? value : {};

  requireString(job.jobId, "jobId", errors);
  requireString(job.sessionId, "sessionId", errors);
  requireString(job.prompt, "prompt", errors);
  requireString(job.repository?.fullName, "repository.fullName", errors);

  if (!job.repository || typeof job.repository !== "object") {
    errors.push("repository must be an object");
  }

  if (!job.target || typeof job.target !== "object") {
    errors.push("target must be an object");
  }

  if (!job.agent || typeof job.agent !== "object") {
    errors.push("agent must be an object");
  }

  if (errors.length > 0) {
    const error = new Error(`Invalid worker job: ${errors.join(", ")}`);
    error.code = "INVALID_JOB";
    if (typeof job.jobId === "string" && typeof job.sessionId === "string") {
      error.partialJob = {
        jobId: job.jobId,
        sessionId: job.sessionId,
        attempt: positiveIntegerOrNull(job.attempt) || 1,
        repository: {
          fullName: job.repository?.fullName || "unknown",
        },
        target: job.target || {},
        raw: job,
      };
    }
    throw error;
  }

  const repositoryName = job.repository.name || job.repository.fullName.split("/").at(-1);
  const repositoryOwner = job.repository.owner || job.repository.fullName.split("/").at(0);

  return {
    jobId: job.jobId,
    sessionId: job.sessionId,
    attempt: positiveIntegerOrNull(job.attempt),
    prompt: job.prompt,
    repository: {
      owner: repositoryOwner,
      name: repositoryName,
      fullName: job.repository.fullName,
      cloneUrl: job.repository.cloneUrl || "",
      defaultBranch: job.repository.defaultBranch || "main",
    },
    target: {
      kind: job.target.kind || "issue",
      issueNumber: nullableNumber(job.target.issueNumber),
      pullRequestNumber: nullableNumber(job.target.pullRequestNumber),
      commentId: nullableNumber(job.target.commentId),
      actor: job.target.actor || "unknown",
      triggerText: job.target.triggerText || "",
    },
    agent: {
      mode: job.agent.mode || "echo",
      model: job.agent.model || "local/echo",
      agentName: job.agent.agentName || "build",
      timeoutSeconds: nullableNumber(job.agent.timeoutSeconds) || 60,
      workspaceDir: job.agent.workspaceDir || null,
      opencode: {
        apiBaseUrl: job.agent.opencode?.apiBaseUrl || null,
        startServer: job.agent.opencode?.startServer ?? true,
        hostname: job.agent.opencode?.hostname || "127.0.0.1",
        port: nullableNumber(job.agent.opencode?.port) || 0,
        serverPassword: job.agent.opencode?.serverPassword || null,
        apiDocUrl: job.agent.opencode?.apiDocUrl || null,
        command: job.agent.opencode?.command || "opencode",
      },
      langfuse: {
        enabled: Boolean(job.agent.langfuse?.enabled),
        traceId: job.agent.langfuse?.traceId || job.sessionId,
        sessionId: job.agent.langfuse?.sessionId || job.sessionId,
        tags: Array.isArray(job.agent.langfuse?.tags) ? job.agent.langfuse.tags : [],
      },
    },
    raw: job,
  };
}

function requireString(value, field, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${field} is required`);
  }
}

function positiveIntegerOrNull(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function nullableNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
