import crypto from "node:crypto";

const PLAN_MARKER = "<!-- agent-plan:";

export function buildWorkerJob({ event, command, config, latestPlan = "" }) {
  const repository = event.repository || {};
  const issue = event.issue || {};
  const actor = event.comment?.user?.login || event.sender?.login || issue.user?.login || "unknown";
  const now = Date.now();
  const issueOrPrNumber = issue.number || 0;
  const isPr = Boolean(issue.pull_request);
  const seed = [
    repository.full_name || "unknown",
    issueOrPrNumber,
    event.comment?.id || event.action || "event",
    command.action,
    now,
  ].join(":");
  const id = idFrom(seed).slice(0, 12);
  const sessionId = sessionIdFor(repository.full_name, issueOrPrNumber, command.action);

  return {
    jobId: `job_${command.action}_${id}`,
    sessionId,
    attempt: 1,
    prompt: buildPrompt({ event, command, latestPlan }),
    repository: {
      owner: repository.owner?.login || repository.full_name?.split("/")[0] || "",
      name: repository.name || repository.full_name?.split("/")[1] || "",
      fullName: repository.full_name || "unknown/unknown",
      cloneUrl: repository.clone_url || "",
      defaultBranch: repository.default_branch || "main",
    },
    target: {
      action: command.action,
      kind: isPr ? "pull_request" : "issue",
      issueNumber: isPr ? null : issueOrPrNumber,
      pullRequestNumber: isPr ? issueOrPrNumber : null,
      commentId: event.comment?.id || null,
      actor,
      triggerText: event.comment?.body || issue.body || "",
    },
    agent: {
      mode: config.agentMode,
      model: config.agentModel,
      agentName: config.agentName,
      timeoutSeconds: config.opencodeTimeoutSeconds,
      workspaceDir: config.workerWorkspaceDir || null,
      opencode: {
        startServer: true,
      },
      langfuse: {
        enabled: false,
        traceId: sessionId,
        sessionId,
        tags: ["orchestrator", command.action],
      },
    },
  };
}

export function buildPrompt({ event, command, latestPlan = "" }) {
  const repository = event.repository?.full_name || "unknown";
  const issue = event.issue || {};
  const actor = event.comment?.user?.login || event.sender?.login || "unknown";

  if (command.action === "plan") {
    return [
      "You are the planning phase of a GitHub issue-to-PR coding agent.",
      "",
      "Analyze the repository and issue. Produce an implementation plan only.",
      "",
      `Repository: ${repository}`,
      `Issue: #${issue.number || "unknown"} ${issue.title || ""}`,
      `Requester: ${actor}`,
      "",
      "Issue body:",
      fenced(issue.body || ""),
      "",
      event.comment ? `Planning comment:\n${fenced(event.comment.body || "")}` : "",
    ].filter(Boolean).join("\n");
  }

  if (command.action === "approve") {
    return [
      "You are the implementation phase of a GitHub issue-to-PR coding agent.",
      "",
      "Implement the approved plan for this issue. Keep changes focused and avoid unrelated refactors.",
      "",
      `Repository: ${repository}`,
      `Issue: #${issue.number || "unknown"} ${issue.title || ""}`,
      "",
      "Issue body:",
      fenced(issue.body || ""),
      "",
      "Approved plan:",
      fenced(latestPlan || "No prior plan was found by the orchestrator."),
      "",
      "Approval comment:",
      fenced(event.comment?.body || ""),
    ].join("\n");
  }

  return [
    "You are updating an existing agent-created pull request based on reviewer feedback.",
    "",
    "Apply only the requested improvement. Keep the PR branch focused.",
    "",
    `Repository: ${repository}`,
    `Pull request: #${issue.number || "unknown"} ${issue.title || ""}`,
    "",
    "Reviewer request:",
    fenced(command.remainder || event.comment?.body || ""),
  ].join("\n");
}

export function extractLatestPlan(comments) {
  const plans = (comments || [])
    .filter((comment) => typeof comment.body === "string" && comment.body.includes(PLAN_MARKER));
  const latest = plans.at(-1);
  if (!latest) return "";
  return latest.body.replace(/<!-- agent-plan:[\s\S]*?-->/g, "").trim();
}

function sessionIdFor(repositoryFullName, number, action) {
  const slug = String(repositoryFullName || "unknown")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
  return `session_${slug}_${number || "event"}_${action}`;
}

function fenced(value) {
  return `\`\`\`markdown\n${String(value).replaceAll("```", "`\u200b``")}\n\`\`\``;
}

function idFrom(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
