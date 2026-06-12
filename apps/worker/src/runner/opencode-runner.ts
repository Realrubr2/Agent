import { OpencodeApiClient } from "../services/opencode-api-client.js";
import { OpencodeProcessManager } from "../services/opencode-process-manager.js";
import { createLangfuseSink } from "../services/langfuse-sink.js";
import { redactSecrets } from "../utils/redact.js";

export class OpencodeRunner {
  constructor(options = {}) {
    this.kind = "opencode";
    this.label = "Opencode";
    this.env = options.env || process.env;
    this.store = options.store;
    this.dependencies = options.dependencies || {};
  }

  async run(job, context = {}) {
    const attempt = context.attempt || job.attempt || 1;
    const mode = job.agent.mode;
    const sink = this.dependencies.langfuseSink || createLangfuseSink(job, this.env);
    const processManager = this.dependencies.processManager || new OpencodeProcessManager({
      env: this.env,
      store: this.store,
    });

    await sink.startRun(job, { attempt });

    let server;
    try {
      const apiBaseUrl = job.agent.opencode.apiBaseUrl;
      if (apiBaseUrl) {
        server = { baseUrl: apiBaseUrl, stop: async () => {} };
      } else {
        server = await processManager.start(job, { attempt });
      }

      const client = this.dependencies.apiClient || new OpencodeApiClient({
        baseUrl: server.baseUrl,
        password: job.agent.opencode.serverPassword,
      });

      const health = await client.health();
      const doc = await client.docSummary();

      await this.append(job, attempt, "system", "opencode_server_ready", `opencode ${health.version || "unknown"} ready at ${redactSecrets(server.baseUrl)}`);
      await this.append(job, attempt, "system", "opencode_api_doc_loaded", `OpenAPI paths discovered: ${doc.pathCount}`);

      if (mode === "opencode-server-check") {
        const result = {
          kind: "opencode",
          mode,
          sessionId: job.sessionId,
          jobId: job.jobId,
          attempt,
          status: "succeeded",
          summary: `Started opencode server and verified ${doc.pathCount} API paths.`,
          stdout: [
            "Agent worker opencode server check",
            `sessionId=${job.sessionId}`,
            `jobId=${job.jobId}`,
            `attempt=${attempt}`,
            `opencodeVersion=${health.version || "unknown"}`,
            `apiPathCount=${doc.pathCount}`,
          ].join("\n"),
          opencode: {
            serverChecked: true,
            version: health.version || null,
            apiPathCount: doc.pathCount,
            apiBaseUrl: redactSecrets(server.baseUrl),
          },
        };
        await sink.finishRun(job, result);
        return result;
      }

      const opencodeSession = await client.createSession(job);
      await this.append(job, attempt, "system", "opencode_session_created", `opencodeSessionId=${opencodeSession.id}`);

      const events = await client.sendPrompt(opencodeSession.id, job);
      for (const event of events) {
        await this.appendEvent(job, attempt, event);
        await sink.recordEvent(job, event);
      }

      const result = {
        kind: "opencode",
        mode,
        sessionId: job.sessionId,
        jobId: job.jobId,
        attempt,
        opencodeSessionId: opencodeSession.id,
        status: "succeeded",
        summary: summarizeEvents(events, opencodeSession.id),
        stdout: [
          "Agent worker opencode runner",
          `sessionId=${job.sessionId}`,
          `jobId=${job.jobId}`,
          `attempt=${attempt}`,
          `opencodeSessionId=${opencodeSession.id}`,
          `events=${events.length}`,
        ].join("\n"),
        opencode: {
          sessionId: opencodeSession.id,
          model: job.agent.model,
          agentName: job.agent.agentName,
          apiBaseUrl: redactSecrets(server.baseUrl),
          eventCount: events.length,
        },
      };
      await sink.finishRun(job, result);
      return result;
    } catch (error) {
      await sink.failRun(job, error).catch(async (sinkError) => {
        await this.append(job, attempt, "system", "langfuse_warning", sinkError.message || String(sinkError));
      });
      throw error;
    } finally {
      if (server?.stop) await server.stop();
    }
  }

  async append(job, attempt, role, type, message) {
    if (!this.store?.appendTranscript) return;
    await this.store.appendTranscript(job.sessionId, {
      jobId: job.jobId,
      attempt,
      role,
      type,
      message: redactSecrets(message),
    });
  }

  async appendEvent(job, attempt, event) {
    const normalized = normalizeEvent(event);
    await this.append(job, attempt, normalized.role, normalized.type, normalized.message);
  }
}

function normalizeEvent(event) {
  const type = event.type || event.event || "opencode_event";
  if (type.includes("tool")) {
    return { role: "tool", type, message: event.message || event.name || JSON.stringify(event) };
  }
  if (type.includes("assistant")) {
    return { role: "assistant", type, message: event.message || event.text || JSON.stringify(event) };
  }
  if (type.includes("error")) {
    return { role: "system", type, message: event.message || JSON.stringify(event) };
  }
  return { role: "system", type, message: event.message || event.text || JSON.stringify(event) };
}

function summarizeEvents(events, sessionId) {
  const final = [...events].reverse().find((event) => event.type === "final" || event.type === "assistant_final");
  if (final?.message || final?.text) return final.message || final.text;
  return `Opencode session ${sessionId} completed with ${events.length} event(s).`;
}
