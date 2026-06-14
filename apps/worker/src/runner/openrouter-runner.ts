import { redactSecrets } from "../utils/redact.js";

export class OpenRouterRunner {
  constructor(options = {}) {
    this.kind = "openrouter";
    this.label = "OpenRouter";
    this.env = options.env || process.env;
    this.fetch = options.fetch || fetch;
  }

  async run(job, context = {}) {
    const attempt = context.attempt || job.attempt || 1;
    if (["approve", "improve"].includes(job.target?.action)) {
      throw new Error("OpenRouter runner supports plan jobs only. Use opencode or an agent/tool runner for approve/improve.");
    }

    const apiKey = this.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY is required for OpenRouter runner.");
    }

    const model = normalizeModel(job.agent.model);
    const response = await this.fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": this.env.OPENROUTER_HTTP_REFERER || "https://github.com",
        "X-OpenRouter-Title": this.env.OPENROUTER_APP_TITLE || "GitHub Agent Webhook",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: "You are a concise GitHub issue planning agent. Produce a practical implementation plan with verification notes.",
          },
          {
            role: "user",
            content: job.prompt,
          },
        ],
      }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`OpenRouter API failed with HTTP ${response.status}: ${redactSecrets(text.slice(0, 1000))}`);
    }

    const payload = text ? JSON.parse(text) : {};
    const content = payload.choices?.[0]?.message?.content || "";
    if (!content.trim()) {
      throw new Error("OpenRouter response did not include assistant content.");
    }

    return {
      kind: "openrouter",
      sessionId: job.sessionId,
      jobId: job.jobId,
      attempt,
      status: "succeeded",
      summary: content,
      stdout: content,
      openrouter: {
        model,
        id: payload.id || null,
      },
    };
  }
}

function normalizeModel(model) {
  const value = String(model || "").trim();
  if (value.startsWith("openrouter/")) return value.slice("openrouter/".length);
  return value || "openai/gpt-4.1-mini";
}
