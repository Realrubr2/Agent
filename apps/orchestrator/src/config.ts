import path from "node:path";

export function loadConfig(env = process.env) {
  const port = numberFrom(env.ORCHESTRATOR_PORT, 8787);
  const host = env.ORCHESTRATOR_HOST || "127.0.0.1";
  const repoAllowlist = listFrom(env.ORCHESTRATOR_REPOSITORIES || env.GITHUB_REPOSITORY);
  const allowedAssociations = listFrom(env.AGENT_ALLOWED_ASSOCIATIONS || "OWNER,MEMBER,COLLABORATOR")
    .map((value) => value.toUpperCase());
  const agentMode = env.ORCHESTRATOR_AGENT_MODE || env.AGENT_MODE || "echo";
  const agentModel = env.ORCHESTRATOR_AGENT_MODEL || env.provider_model || env.PROVIDER_MODEL || "local/echo";
  const implementationMode = isOpenRouterMode(agentMode) ? "opencode" : agentMode;

  return {
    host,
    port,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET || "",
    repositoryAllowlist: repoAllowlist,
    allowedAssociations,
    commandPrefixes: listFrom(env.ORCHESTRATOR_COMMAND_PREFIXES || "agent,opencode")
      .map((value) => value.replace(/^\/+/, ""))
      .filter(Boolean),
    agentMode,
    agentModel,
    planAgentMode: env.ORCHESTRATOR_PLAN_AGENT_MODE || agentMode,
    planAgentModel: env.ORCHESTRATOR_PLAN_AGENT_MODEL || agentModel,
    implementationAgentMode: env.ORCHESTRATOR_IMPLEMENT_AGENT_MODE || implementationMode,
    implementationAgentModel: env.ORCHESTRATOR_IMPLEMENT_AGENT_MODEL || agentModel,
    agentName: env.ORCHESTRATOR_AGENT_NAME || "build",
    workerImage: env.ORCHESTRATOR_WORKER_IMAGE || "agent-worker:local",
    workerLaunchMode: env.ORCHESTRATOR_WORKER_LAUNCH_MODE || "docker",
    workerStoreDir: path.resolve(env.AGENT_STORE_DIR || ".tmp/agent-store"),
    workerWorkspaceDir: env.ORCHESTRATOR_WORKSPACE_DIR || env.WORKSPACE_DIR || "",
    containerStoreDir: env.ORCHESTRATOR_CONTAINER_STORE_DIR || "/data",
    containerWorkspaceDir: env.ORCHESTRATOR_CONTAINER_WORKSPACE_DIR || "/workspace",
    dockerVolumeSuffix: env.ORCHESTRATOR_DOCKER_VOLUME_SUFFIX || "",
    githubToken: env.GITHUB_TOKEN || env.GH_TOKEN || "",
    githubApiBaseUrl: env.GITHUB_API_BASE_URL || "https://api.github.com",
    githubDryRun: booleanFrom(env.ORCHESTRATOR_GITHUB_DRY_RUN),
    providerEnvNames: listFrom(env.ORCHESTRATOR_PROVIDER_ENV || "OPENAI_API_KEY,ANTHROPIC_API_KEY,OPENROUTER_API_KEY"),
    workerTimeoutSeconds: numberFrom(env.ORCHESTRATOR_WORKER_TIMEOUT_SECONDS, 900),
    opencodeTimeoutSeconds: numberFrom(env.ORCHESTRATOR_OPENCODE_TIMEOUT_SECONDS, 300),
  };
}

function isOpenRouterMode(value) {
  return ["openrouter", "openrouter-chat"].includes(String(value || "").toLowerCase());
}

function listFrom(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function numberFrom(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanFrom(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}
