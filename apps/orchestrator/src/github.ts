export class GitHubClient {
  constructor(options = {}) {
    this.token = options.token || "";
    this.apiBaseUrl = (options.apiBaseUrl || "https://api.github.com").replace(/\/$/, "");
    this.dryRun = Boolean(options.dryRun);
    this.fetch = options.fetch || fetch;
  }

  async createIssueComment(repositoryFullName, issueNumber, body) {
    if (this.dryRun || !this.token) {
      console.log(`[github:dry-run] comment on ${repositoryFullName}#${issueNumber}\n${body}`);
      return { dryRun: true, body };
    }

    return await this.request(
      `/repos/${repositoryFullName}/issues/${issueNumber}/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body }),
      },
    );
  }

  async listIssueComments(repositoryFullName, issueNumber) {
    if (this.dryRun || !this.token) return [];
    return await this.request(`/repos/${repositoryFullName}/issues/${issueNumber}/comments`);
  }

  async request(pathname, options = {}) {
    const response = await this.fetch(`${this.apiBaseUrl}${pathname}`, {
      method: options.method || "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "agent-orchestrator",
        Authorization: `Bearer ${this.token}`,
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
}
