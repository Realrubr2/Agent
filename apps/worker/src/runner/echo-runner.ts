import { promptHash, sanitizePromptForLog, summarizePrompt } from "../utils/prompt.js";

export class EchoRunner {
  constructor() {
    this.kind = "echo";
    this.label = "Echo";
  }

  async run(job, context = {}) {
    const attempt = context.attempt || job.attempt || 1;
    const promptSummary = summarizePrompt(job.prompt);
    const hash = promptHash(job.prompt);

    return {
      kind: "echo",
      sessionId: job.sessionId,
      jobId: job.jobId,
      attempt,
      repositoryFullName: job.repository.fullName,
      promptHash: hash,
      promptSummary,
      stdout: [
        "Agent worker echo runner",
        `sessionId=${job.sessionId}`,
        `jobId=${job.jobId}`,
        `attempt=${attempt}`,
        `repository=${job.repository.fullName}`,
        `prompt=${sanitizePromptForLog(job.prompt)}`,
      ].join("\n"),
      summary: `Echoed prompt for ${job.repository.fullName} in session ${job.sessionId}.`,
    };
  }
}
