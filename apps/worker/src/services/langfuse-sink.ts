export function createLangfuseSink(job, env = process.env) {
  const enabled = Boolean(job.agent?.langfuse?.enabled && env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY);
  return enabled ? new ConsoleLangfuseSink() : new DisabledLangfuseSink();
}

export class DisabledLangfuseSink {
  constructor() {
    this.enabled = false;
    this.events = [];
  }

  async startRun(job, context) {
    this.events.push({ type: "start", jobId: job.jobId, attempt: context.attempt });
  }

  async recordEvent(job, event) {
    this.events.push({ type: "event", jobId: job.jobId, eventType: event.type });
  }

  async finishRun(job, result) {
    this.events.push({ type: "finish", jobId: job.jobId, status: result.status });
  }

  async failRun(job, error) {
    this.events.push({ type: "fail", jobId: job.jobId, message: error?.message || String(error) });
  }
}

class ConsoleLangfuseSink extends DisabledLangfuseSink {
  constructor() {
    super();
    this.enabled = true;
  }
}
