#!/usr/bin/env node
import { loadConfig, validateRequiredServiceEnv } from "./config.js";
import { GitHubClient } from "./github.js";
import { WorkerLauncher } from "./launcher.js";
import { createServer } from "./webhook.js";

const config = loadConfig(process.env);
validateRequiredServiceEnv(config, process.env);
const github = new GitHubClient({
  token: config.githubToken,
  apiBaseUrl: config.githubApiBaseUrl,
  dryRun: config.githubDryRun,
});
const launcher = new WorkerLauncher({ config, env: process.env });
const server = createServer({ config, github, launcher });

server.listen(config.port, config.host, () => {
  console.log(`Agent orchestrator listening on http://${config.host}:${config.port}`);
  console.log(`Worker launch mode: ${config.workerLaunchMode}`);
});
