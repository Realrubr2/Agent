import { EchoRunner } from "./echo-runner.js";
import { OpencodeRunner } from "./opencode-runner.js";

export function createRunner(job, options = {}) {
  const mode = job.agent?.mode || "echo";

  if (mode === "echo") return new EchoRunner();
  if (mode === "opencode" || mode === "opencode-api" || mode === "opencode-server-check") {
    return new OpencodeRunner(options);
  }

  throw new Error(`Unsupported agent mode: ${mode}`);
}
