import { createOpencodeClient } from "@opencode-ai/sdk";

export class OpencodeSdkClient {
  constructor(options = {}) {
    if (!options.baseUrl) throw new Error("OpencodeSdkClient requires baseUrl.");
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.directory = options.directory || null;
    this.password = options.password || null;
    this.fetch = options.fetch || fetch;
    this.client = options.client || createOpencodeClient({
      baseUrl: this.baseUrl,
      fetch: sdkFetch(this.fetch),
      headers: this.headers(),
    });
  }

  async health() {
    const config = await this.config();
    return {
      healthy: true,
      version: config.version || null,
      config,
    };
  }

  async docSummary() {
    return {
      title: "opencode-sdk",
      version: null,
      pathCount: 3,
      paths: ["config.get", "session.create", "session.prompt"],
    };
  }

  async createSession(job) {
    const response = await unwrap(this.client.session.create({
      body: {
        title: `Agent ${job.target.kind || "target"} ${job.target.issueNumber || job.target.pullRequestNumber || job.jobId}`,
      },
      query: this.query(job),
      throwOnError: true,
    }), "session.create");
    return {
      id: response.id || response.sessionID || response.sessionId,
      raw: response,
    };
  }

  async sendPrompt(sessionId, job) {
    const response = await unwrap(this.client.session.prompt({
      path: { id: sessionId },
      query: this.query(job),
      body: {
        parts: [
          {
            type: "text",
            text: job.prompt,
          },
        ],
        model: modelPayload(job.agent.model),
        agent: job.agent.agentName,
      },
      throwOnError: true,
    }), "session.prompt");

    if (response.info?.error) {
      throw new Error(`opencode session failed: ${messageError(response.info.error)}`);
    }

    return normalizePromptResponse(response);
  }

  async abort(sessionId, job = {}) {
    return await unwrap(this.client.session.abort({
      path: { id: sessionId },
      query: this.query(job),
      throwOnError: true,
    }), "session.abort");
  }

  async config(job = {}) {
    return await unwrap(this.client.config.get({
      query: this.query(job),
      throwOnError: true,
    }), "config.get");
  }

  query(job = {}) {
    const directory = job.agent?.workspaceDir || this.directory;
    return directory ? { directory } : undefined;
  }

  headers() {
    if (!this.password) return {};
    return {
      Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`,
    };
  }
}

function normalizePromptResponse(response) {
  const parts = Array.isArray(response.parts) ? response.parts : [];
  const events = [];

  for (const part of parts) {
    if (part.type === "tool") {
      events.push({
        type: part.state?.status === "error" ? "tool_error" : "tool_completed",
        name: part.tool,
        message: part.state?.output || part.state?.error || part.state?.title || part.tool,
        raw: part,
      });
    }
    if (part.type === "text" && part.text) {
      events.push({
        type: "assistant_final",
        message: part.text,
        raw: part,
      });
    }
  }

  if (events.length > 0) return events;
  return [{
    type: "assistant_final",
    message: response.info?.finish || "Opencode prompt completed.",
    raw: response,
  }];
}

function sdkFetch(fetchImpl) {
  return async (request) => {
    try {
      return await fetchImpl(request);
    } catch (error) {
      const url = new URL(request.url);
      const cause = error?.cause;
      const causeMessage = cause?.message || cause?.code || "";
      const reason = error?.message || String(error);
      const detail = causeMessage && !reason.includes(causeMessage) ? `${reason}: ${causeMessage}` : reason;
      throw new Error(`opencode SDK request failed for ${url.pathname}: ${detail}`);
    }
  };
}

async function unwrap(work, operation) {
  const result = await work;
  if (result?.error) {
    throw new Error(`opencode SDK ${operation} failed: ${messageError(result.error)}`);
  }
  if (result && "data" in result) return result.data;
  return result;
}

function messageError(error) {
  if (!error) return "unknown error";
  if (typeof error === "string") return error;
  if (error.data?.message) return error.data.message;
  if (error.message) return error.message;
  if (error.name) return error.name;
  return JSON.stringify(error);
}

function modelPayload(model) {
  if (!model || !model.includes("/")) return undefined;
  const [providerID, ...rest] = model.split("/");
  return {
    providerID,
    modelID: rest.join("/"),
  };
}
