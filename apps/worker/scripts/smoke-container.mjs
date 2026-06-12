#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(workerRoot, "../..");
const examplesDir = path.join(workerRoot, "examples");
const smokeRoot = fs.mkdtempSync(path.join("/tmp", "agent-worker-container-smoke-"));
const echoStore = path.join(smokeRoot, "echo");
const opencodeStore = path.join(smokeRoot, "opencode-server-check");

fs.mkdirSync(smokeRoot, { recursive: true });

run("docker", ["run", "--rm", "agent-worker:local", "opencode", "--version"]);
run("docker", [
  "run", "--rm",
  "-e", "JOB_FILE=/input/job.json",
  "-e", "AGENT_STORE_DIR=/data",
  "-v", `${examplesDir}:/input`,
  "-v", `${echoStore}:/data`,
  "agent-worker:local",
]);
run("docker", [
  "run", "--rm",
  "-e", "JOB_FILE=/input/job-opencode-server-check.json",
  "-e", "AGENT_STORE_DIR=/data",
  "-v", `${examplesDir}:/input`,
  "-v", `${opencodeStore}:/data`,
  "agent-worker:local",
]);

assertJson(path.join(echoStore, "sessions", "session_demo_001.json"), (session) => {
  assert(session.status === "succeeded", "echo session should succeed");
  assert(session.attemptCount === 1, "echo smoke should record one attempt");
});

assertJson(path.join(opencodeStore, "sessions", "session_opencode_server_check_001.json"), (session) => {
  assert(session.status === "succeeded", "opencode server-check session should succeed");
  assert(session.opencode?.serverChecked === true, "opencode server-check metadata should be stored");
  assert(session.opencode?.version, "opencode version should be stored");
  assert(session.opencode?.apiPathCount > 0, "opencode API path count should be stored");
});

const transcriptPath = path.join(opencodeStore, "transcripts", "session_opencode_server_check_001.jsonl");
const transcript = fs.readFileSync(transcriptPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const sequences = transcript.map((entry) => entry.sequence);
const expected = Array.from({ length: sequences.length }, (_, index) => index + 1);
assert(JSON.stringify(sequences) === JSON.stringify(expected), "transcript sequence numbers should be contiguous");
assert(transcript.some((entry) => entry.type === "opencode_server_ready"), "transcript should include opencode_server_ready");
assert(transcript.some((entry) => entry.type === "opencode_api_doc_loaded"), "transcript should include opencode_api_doc_loaded");

console.log(`Container smoke tests passed. Stores written under ${smokeRoot}`);

function run(command, args) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  execFileSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

function assertJson(file, check) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  check(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
