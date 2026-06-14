import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class WorkerLauncher {
  constructor(options = {}) {
    this.config = options.config;
    this.env = options.env || process.env;
    this.spawn = options.spawn || spawn;
    this.repoRoot = options.repoRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  }

  async launch(job) {
    const mode = this.config.workerLaunchMode;
    if (mode === "dry-run") return dryRunResult(job);
    await fs.mkdir(this.config.workerStoreDir, { recursive: true });
    if (mode === "process") return await this.launchProcess(job);
    if (mode === "docker") return await this.launchDocker(job);
    throw new Error(`Unsupported worker launch mode: ${mode}`);
  }

  async launchProcess(job) {
    return await this.run("node", ["apps/worker/dist/main.js"], {
      cwd: this.repoRoot,
      env: this.workerEnv(job),
    });
  }

  async launchDocker(job) {
    const args = [
      "run", "--rm",
      "-e", "JOB_JSON",
      "-e", `AGENT_STORE_DIR=${this.config.containerStoreDir}`,
    ];

    for (const name of this.config.providerEnvNames) {
      if (this.env[name]) args.push("-e", name);
    }
    for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "AGENT_GIT_AUTHOR_NAME", "AGENT_GIT_AUTHOR_EMAIL"]) {
      if (this.env[name]) args.push("-e", name);
    }

    args.push("-v", this.volumeSpec(this.config.workerStoreDir, this.config.containerStoreDir));

    if (this.config.workerWorkspaceDir) {
      args.push("-v", this.volumeSpec(path.resolve(this.config.workerWorkspaceDir), this.config.containerWorkspaceDir));
      job.agent.workspaceDir = this.config.containerWorkspaceDir;
    }

    args.push(this.config.workerImage);

    return await this.run("docker", args, {
      cwd: this.repoRoot,
      env: this.workerEnv(job),
    });
  }

  volumeSpec(hostPath, containerPath) {
    return `${hostPath}:${containerPath}${this.config.dockerVolumeSuffix || ""}`;
  }

  workerEnv(job) {
    const env = {
      ...this.env,
      JOB_JSON: JSON.stringify(job),
      AGENT_STORE_DIR: this.config.workerStoreDir,
    };
    for (const name of this.config.providerEnvNames) {
      if (!this.env[name]) delete env[name];
    }
    return env;
  }

  run(command, args, options) {
    return new Promise((resolve, reject) => {
      const child = this.spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Worker timed out after ${this.config.workerTimeoutSeconds}s`));
      }, this.config.workerTimeoutSeconds * 1000);

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => { stdout += chunk; });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        const result = { status: code === 0 ? "succeeded" : "failed", code, signal, stdout, stderr };
        if (code === 0) resolve(result);
        else reject(Object.assign(new Error(`Worker exited with code ${code}${signal ? ` from ${signal}` : ""}`), { result }));
      });
    });
  }
}

function dryRunResult(job) {
  const stdout = [
    "Agent orchestrator dry run",
    `jobId=${job.jobId}`,
    `sessionId=${job.sessionId}`,
    `mode=${job.agent.mode}`,
    `repository=${job.repository.fullName}`,
  ].join("\n");
  console.log(stdout);
  return { status: "succeeded", code: 0, signal: null, stdout, stderr: "" };
}
