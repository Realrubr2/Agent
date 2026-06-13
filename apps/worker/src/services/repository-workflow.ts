import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { redactSecrets } from "../utils/redact.js";

const execFileAsync = promisify(execFile);

export class RepositoryWorkflow {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.store = options.store;
    this.execFile = options.execFile || execFileAsync;
    this.fetch = options.fetch || fetch;
  }

  shouldRun(job) {
    return ["approve", "improve"].includes(job.target?.action);
  }

  async prepare(job, context = {}) {
    if (!this.shouldRun(job)) return null;

    const token = this.token();
    if (!token) {
      throw new Error("GITHUB_TOKEN or GH_TOKEN is required for approve/improve worker runs.");
    }

    const attempt = context.attempt || job.attempt || 1;
    const branch = await this.branchFor(job);
    const workspaceDir = path.join(
      this.workspaceRoot(),
      safePathSegment(job.repository.fullName),
      safePathSegment(job.sessionId),
      String(attempt),
      "repo",
    );

    await fs.rm(workspaceDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(workspaceDir), { recursive: true });
    await this.append(job, attempt, "repository_clone_start", `Cloning ${job.repository.fullName} into ${workspaceDir}`);

    const cloneUrl = authenticatedCloneUrl(job.repository.cloneUrl || `https://github.com/${job.repository.fullName}.git`, token);
    await this.git(["clone", "--depth", "1", "--branch", branch.baseRef, cloneUrl, workspaceDir], {
      cwd: path.dirname(workspaceDir),
    });
    await this.git(["remote", "set-url", "origin", cloneUrl], { cwd: workspaceDir });

    if (job.target.action === "approve") {
      await this.git(["checkout", "-b", branch.headRef], { cwd: workspaceDir });
    } else {
      await this.git(["checkout", branch.headRef], { cwd: workspaceDir });
    }

    job.agent.workspaceDir = workspaceDir;
    job.workflow = {
      ...(job.workflow || {}),
      repository: {
        workspaceDir,
        baseRef: branch.baseRef,
        headRef: branch.headRef,
      },
    };

    await this.append(job, attempt, "repository_ready", `Repository ready on ${branch.headRef}`);
    return job.workflow.repository;
  }

  async finalize(job, result, context = {}) {
    const repository = job.workflow?.repository;
    if (!repository || !this.shouldRun(job)) return result;

    const attempt = context.attempt || job.attempt || 1;
    const cwd = repository.workspaceDir;
    const status = await this.git(["status", "--porcelain"], { cwd });
    if (!status.stdout.trim()) {
      await this.append(job, attempt, "repository_no_changes", "No repository changes detected.");
      return {
        ...result,
        summary: `${result.summary || "Worker completed."}\n\nNo repository changes were detected.`,
        git: {
          changed: false,
          branch: repository.headRef,
        },
      };
    }

    await this.git(["config", "user.name", this.env.AGENT_GIT_AUTHOR_NAME || "Agent Bot"], { cwd });
    await this.git(["config", "user.email", this.env.AGENT_GIT_AUTHOR_EMAIL || "agent@example.invalid"], { cwd });
    await this.git(["add", "-A"], { cwd });
    await this.git(["commit", "-m", commitMessage(job)], { cwd });
    await this.git(["push", "-u", "origin", `HEAD:${repository.headRef}`], { cwd });

    let pullRequest = null;
    if (job.target.action === "approve") {
      pullRequest = await this.createPullRequest(job, repository);
      await this.append(job, attempt, "pull_request_created", pullRequest.html_url || `#${pullRequest.number}`);
    } else {
      await this.append(job, attempt, "pull_request_updated", `Pushed updates to ${repository.headRef}`);
    }

    return {
      ...result,
      summary: [
        result.summary || "Worker completed.",
        "",
        pullRequest?.html_url
          ? `Pull request: ${pullRequest.html_url}`
          : `Pushed updates to ${repository.headRef}.`,
      ].join("\n"),
      stdout: [
        result.stdout,
        pullRequest?.html_url ? `pullRequest=${pullRequest.html_url}` : "",
        `branch=${repository.headRef}`,
      ].filter(Boolean).join("\n"),
      git: {
        changed: true,
        branch: repository.headRef,
        pullRequestUrl: pullRequest?.html_url || null,
        pullRequestNumber: pullRequest?.number || job.target.pullRequestNumber || null,
      },
    };
  }

  async branchFor(job) {
    if (job.target.action === "improve") {
      const pr = await this.githubJson(`/repos/${job.repository.fullName}/pulls/${job.target.pullRequestNumber}`);
      if (pr.head?.repo?.full_name !== job.repository.fullName) {
        throw new Error("Refusing to update a pull request branch from a fork.");
      }
      return {
        baseRef: pr.head.ref,
        headRef: pr.head.ref,
      };
    }

    return {
      baseRef: job.repository.defaultBranch || "main",
      headRef: `agent/issue-${job.target.issueNumber || "unknown"}-${job.jobId.replace(/^job_approve_/, "").slice(0, 12)}`,
    };
  }

  async createPullRequest(job, repository) {
    return await this.githubJson(`/repos/${job.repository.fullName}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title: `Implement #${job.target.issueNumber} with agent`,
        head: repository.headRef,
        base: repository.baseRef,
        body: [
          job.target.issueNumber ? `Closes #${job.target.issueNumber}` : "",
          "",
          "## Agent Notes",
          "This pull request was generated by the webhook agent.",
        ].filter(Boolean).join("\n"),
      }),
    });
  }

  async githubJson(pathname, options = {}) {
    const response = await this.fetch(`https://api.github.com${pathname}`, {
      method: options.method || "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "agent-worker",
        Authorization: `Bearer ${this.token()}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: options.body,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`GitHub API ${pathname} failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) : {};
  }

  async git(args, options = {}) {
    try {
      return await this.execFile("git", args, {
        cwd: options.cwd,
        env: this.env,
        maxBuffer: 1024 * 1024 * 8,
      });
    } catch (error) {
      const stdout = redactSecrets(String(error.stdout || ""));
      const stderr = redactSecrets(String(error.stderr || error.message || ""));
      throw new Error(`git ${args[0]} failed: ${stdout}${stderr ? `\n${stderr}` : ""}`);
    }
  }

  workspaceRoot() {
    return this.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), "agent-worker-workspaces");
  }

  token() {
    return this.env.GITHUB_TOKEN || this.env.GH_TOKEN || "";
  }

  async append(job, attempt, type, message) {
    if (!this.store?.appendTranscript) return;
    await this.store.appendTranscript(job.sessionId, {
      jobId: job.jobId,
      attempt,
      role: "system",
      type,
      message: redactSecrets(message),
    });
  }
}

function authenticatedCloneUrl(cloneUrl, token) {
  const url = new URL(cloneUrl || "https://github.com/unknown/unknown.git");
  url.username = "x-access-token";
  url.password = token;
  return url.toString();
}

function safePathSegment(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function commitMessage(job) {
  if (job.target.action === "improve") {
    return `Update PR #${job.target.pullRequestNumber} with agent`;
  }
  return `Implement #${job.target.issueNumber} with agent`;
}
