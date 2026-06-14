export class OpencodeApiClient {
  constructor(options = {}) {
    if (!options.baseUrl) throw new Error("OpencodeApiClient requires baseUrl.");
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.password = options.password || null;
    this.fetch = options.fetch || fetch;
    this.timeoutMs = options.timeoutMs || 5000;
  }

  async health() {
    return await this.getJson("/global/health");
  }

  async docSummary() {
    const doc = await this.getJson("/doc");
    return {
      title: doc.info?.title || "opencode",
      version: doc.info?.version || null,
      pathCount: Object.keys(doc.paths || {}).length,
      paths: Object.keys(doc.paths || {}),
    };
  }

  async createSession(job) {
    const payload = {
      title: `Agent ${job.target.kind || "target"} ${job.target.issueNumber || job.target.pullRequestNumber || job.jobId}`,
      parentID: undefined,
    };
    const response = await this.postJson("/session", payload, {
      directory: job.agent.workspaceDir || process.cwd(),
    });
    return {
      id: response.id || response.sessionID || response.sessionId,
      raw: response,
    };
  }

  async sendPrompt(sessionId, job) {
    const response = await this.postJson(`/session/${encodeURIComponent(sessionId)}/message`, {
      parts: [
        {
          type: "text",
          text: job.prompt,
        },
      ],
      model: modelPayload(job.agent.model),
      agent: job.agent.agentName,
    }, {
      directory: job.agent.workspaceDir || process.cwd(),
    });

    if (Array.isArray(response)) return response;
    if (Array.isArray(response.events)) return response.events;
    if (response.message || response.text) {
      return [{ type: "assistant_final", message: response.message || response.text }];
    }
    return [{ type: "final", message: "Opencode prompt completed.", raw: response }];
  }

  async abort(sessionId) {
    return await this.postJson(`/session/${encodeURIComponent(sessionId)}/abort`, {});
  }

  async getJson(pathname, query) {
    const response = await fetchWithTimeout(this.fetch, this.url(pathname, query), {
      headers: this.headers(),
    }, this.timeoutMs);
    return await parseJsonResponse(response, pathname);
  }

  async postJson(pathname, body, query) {
    const response = await fetchWithTimeout(this.fetch, this.url(pathname, query), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers(),
      },
      body: JSON.stringify(body),
    }, this.timeoutMs);
    return await parseJsonResponse(response, pathname);
  }

  url(pathname, query = {}) {
    const url = new URL(pathname, this.baseUrl);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  headers() {
    if (!this.password) return {};
    return {
      Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`,
    };
  }
}

async function parseJsonResponse(response, pathname) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`opencode API ${pathname} failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`opencode API request timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function modelPayload(model) {
  if (!model || !model.includes("/")) return undefined;
  const [providerID, ...rest] = model.split("/");
  return {
    providerID,
    modelID: rest.join("/"),
  };
}
