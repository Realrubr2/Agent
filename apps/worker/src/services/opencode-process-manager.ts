import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { OpencodeApiClient } from "./opencode-api-client.js";
import { redactSecrets } from "../utils/redact.js";

export class OpencodeProcessManager {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.store = options.store;
  }

  async start(job, context = {}) {
    const launch = await this.prepareLaunch(job, context);

    await Promise.all([
      fs.mkdir(launch.home, { recursive: true }),
      fs.mkdir(launch.data, { recursive: true }),
      fs.mkdir(launch.config, { recursive: true }),
      fs.mkdir(launch.workspaceDir, { recursive: true }),
    ]);

    await this.append(job, launch.attempt, "opencode_server_starting", `${launch.command} ${launch.args.join(" ")}`);
    const child = spawn(launch.command, launch.args, {
      cwd: launch.workspaceDir,
      env: launch.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      this.append(job, launch.attempt, "opencode_stdout", chunk.toString().trim()).catch(() => {});
    });
    child.stderr.on("data", (chunk) => {
      this.append(job, launch.attempt, "opencode_stderr", chunk.toString().trim()).catch(() => {});
    });

    let exitError;
    child.once("exit", (code, signal) => {
      if (code !== 0 && code !== null) exitError = new Error(`opencode serve exited with code ${code}`);
      if (signal) exitError = new Error(`opencode serve exited from signal ${signal}`);
    });

    const client = new OpencodeApiClient({
      baseUrl: launch.baseUrl,
      password: job.agent.opencode.serverPassword,
    });
    await waitForReady(async () => {
      if (exitError) throw exitError;
      return await client.health();
    }, job.agent.timeoutSeconds);

    return {
      baseUrl: launch.baseUrl,
      pid: child.pid,
      workspaceDir: launch.workspaceDir,
      stop: async () => {
        if (child.exitCode !== null || child.killed) return;
        child.kill("SIGTERM");
        await waitForExit(child, 1500).catch(() => {
          if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
        });
      },
    };
  }

  async prepareLaunch(job, context = {}) {
    const attempt = context.attempt || job.attempt || 1;
    const port = job.agent.opencode.port || await findOpenPort();
    const hostname = job.agent.opencode.hostname || "127.0.0.1";
    const baseUrl = `http://${hostname}:${port}`;
    const workspaceDir = job.agent.workspaceDir || path.join("/tmp", "agent-opencode", job.sessionId, String(attempt));
    const runtimeDir = path.join(workspaceDir, ".opencode-runtime");
    const home = path.join(runtimeDir, "home");
    const data = path.join(runtimeDir, "data");
    const config = path.join(runtimeDir, "config");
    const command = job.agent.opencode.command || "opencode";
    const args = [
      "serve",
      "--hostname", hostname,
      "--port", String(port),
      "--print-logs",
      "--log-level", "INFO",
    ];

    return {
      attempt,
      port,
      hostname,
      baseUrl,
      workspaceDir,
      runtimeDir,
      home,
      data,
      config,
      command,
      args,
      env: {
        ...this.env,
        HOME: home,
        XDG_DATA_HOME: data,
        XDG_CONFIG_HOME: config,
      },
    };
  }

  async append(job, attempt, type, message) {
    if (!this.store?.appendTranscript || !message) return;
    await this.store.appendTranscript(job.sessionId, {
      jobId: job.jobId,
      attempt,
      role: "system",
      type,
      message: redactSecrets(message),
    });
  }
}

async function waitForReady(check, timeoutSeconds = 30) {
  const deadline = Date.now() + Math.min(timeoutSeconds, 60) * 1000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      return await check();
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }

  throw new Error(`Timed out waiting for opencode server readiness: ${lastError?.message || "unknown error"}`);
}

async function findOpenPort() {
  const net = await import("node:net");
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for process exit.")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
