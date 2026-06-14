import crypto from "node:crypto";
import http from "node:http";
import { parseCommand, eventActor, eventAssociation, eventCommandSource, isPullRequestEvent, isTrustedAssociation } from "./commands.js";
import { extractLatestPlan, buildWorkerJob, planMarker } from "./jobs.js";

const ORCHESTRATOR_COMMENT_MARKER = "<!-- agent-orchestrator -->";

export function createServer({ config, github, launcher, logger = console }) {
  return http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        return sendJson(response, 200, { ok: true });
      }

      if (request.method !== "POST" || request.url !== "/webhooks/github") {
        return sendJson(response, 404, { error: "not_found" });
      }

      const rawBody = await readBody(request);
      if (!verifySignature(rawBody, request.headers["x-hub-signature-256"], config.webhookSecret)) {
        return sendJson(response, 401, { error: "invalid_signature" });
      }

      const eventName = String(request.headers["x-github-event"] || "");
      const payload = JSON.parse(rawBody || "{}");
      const result = await handleGitHubEvent({ eventName, payload, config, github, launcher, logger });
      logger.log([
        `Webhook ${eventName || "unknown"}`,
        payload.repository?.full_name ? `repo=${payload.repository.full_name}` : "",
        payload.action ? `action=${payload.action}` : "",
        result.accepted ? "accepted" : "ignored",
        result.reason ? `reason=${result.reason}` : "",
        result.status ? `status=${result.status}` : "",
      ].filter(Boolean).join(" "));
      return sendJson(response, result.accepted ? 202 : 200, result);
    } catch (error) {
      logger.error(error?.stack || String(error));
      return sendJson(response, 500, { accepted: false, error: error.message || String(error) });
    }
  });
}

export async function handleGitHubEvent({ eventName, payload, config, github, launcher, logger = console }) {
  if (!["issue_comment", "issues"].includes(eventName)) {
    return ignored(`unsupported event ${eventName || "unknown"}`);
  }

  if (eventName === "issue_comment" && payload.action !== "created") {
    return ignored(`unsupported issue_comment action ${payload.action || "unknown"}`);
  }
  if (eventName === "issue_comment" && payload.comment?.body?.includes(ORCHESTRATOR_COMMENT_MARKER)) {
    return ignored("orchestrator comment");
  }

  if (eventName === "issues" && !["opened", "edited"].includes(payload.action)) {
    return ignored(`unsupported issues action ${payload.action || "unknown"}`);
  }

  const repositoryFullName = payload.repository?.full_name;
  if (!repositoryFullName) return ignored("missing repository");
  if (config.repositoryAllowlist.length > 0 && !config.repositoryAllowlist.includes(repositoryFullName)) {
    return ignored(`repository ${repositoryFullName} is not allowed`);
  }

  const command = parseCommand(eventCommandSource(payload), config.commandPrefixes);
  if (!command) return ignored("no agent command found");

  if (command.action === "improve" && !isPullRequestEvent(payload)) {
    return ignored("improve commands only run on pull requests");
  }
  if (command.action !== "improve" && isPullRequestEvent(payload)) {
    return ignored(`${command.action} commands only run on issues`);
  }

  const association = eventAssociation(payload);
  if (!isTrustedAssociation(association, config.allowedAssociations)) {
    logger.warn(`Rejected ${command.action} from ${eventActor(payload)} with association ${association || "unknown"}`);
    await github.createIssueComment(repositoryFullName, payload.issue.number, markOrchestratorComment([
      `Agent request rejected for @${eventActor(payload)}.`,
      "",
      `Association \`${association || "unknown"}\` is not allowed to run this agent.`,
    ].join("\n")));
    return { accepted: false, ignored: true, reason: "untrusted_actor" };
  }

  const comments = command.action === "approve"
    ? await github.listIssueComments(repositoryFullName, payload.issue.number)
    : [];
  const latestPlan = extractLatestPlan(comments);
  const job = buildWorkerJob({ event: payload, command, config, latestPlan });

  await github.createIssueComment(repositoryFullName, payload.issue.number, markOrchestratorComment([
    `Agent ${command.action} request accepted.`,
    "",
    `Job: \`${job.jobId}\``,
    `Session: \`${job.sessionId}\``,
  ].join("\n")));

  try {
    const result = await launcher.launch(job);
    await github.createIssueComment(repositoryFullName, payload.issue.number, markOrchestratorComment([
      `Agent ${command.action} worker finished with \`${result.status}\`.`,
      "",
      result.stdout ? fenced(result.stdout.slice(0, 4000)) : "",
      command.action === "plan" ? planMarker(job) : "",
      result.stderr ? `stderr:\n${fenced(result.stderr.slice(0, 4000))}` : "",
    ].filter(Boolean).join("\n")));
    return { accepted: true, jobId: job.jobId, sessionId: job.sessionId, status: result.status };
  } catch (error) {
    const result = error.result;
    await github.createIssueComment(repositoryFullName, payload.issue.number, markOrchestratorComment([
      `Agent ${command.action} worker failed.`,
      "",
      error.message || String(error),
      result?.stderr ? `stderr:\n${fenced(result.stderr.slice(0, 4000))}` : "",
    ].filter(Boolean).join("\n")));
    return { accepted: true, jobId: job.jobId, sessionId: job.sessionId, status: "failed", error: error.message || String(error) };
  }
}

export function verifySignature(rawBody, signatureHeader, secret) {
  if (!secret) return true;
  if (!signatureHeader || !String(signatureHeader).startsWith("sha256=")) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(String(signatureHeader));
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function ignored(reason) {
  return { accepted: false, ignored: true, reason };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function fenced(value) {
  return `\`\`\`text\n${String(value).replaceAll("```", "`\u200b``")}\n\`\`\``;
}

function markOrchestratorComment(body) {
  return `${body}\n\n${ORCHESTRATOR_COMMENT_MARKER}`;
}
