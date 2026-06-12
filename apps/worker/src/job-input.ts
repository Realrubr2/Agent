import fs from "node:fs/promises";
import path from "node:path";
import { validateJob } from "./job-schema.js";

const DEFAULT_JOB_FILE = "apps/worker/examples/job.json";

export async function loadJobInput(env = process.env, store) {
  let raw;

  if (env.JOB_JSON) {
    raw = JSON.parse(env.JOB_JSON);
  } else if (env.JOB_FILE) {
    raw = JSON.parse(await fs.readFile(env.JOB_FILE, "utf8"));
  } else if (env.JOB_ID) {
    if (!store?.loadJobInput) {
      throw new Error("JOB_ID lookup requires a store with loadJobInput support.");
    }
    raw = await store.loadJobInput(env.JOB_ID);
    if (!raw) {
      throw new Error(`No local job record found for JOB_ID ${env.JOB_ID}. Shared lookup is not implemented yet.`);
    }
  } else {
    const defaultPath = path.resolve(DEFAULT_JOB_FILE);
    raw = JSON.parse(await fs.readFile(defaultPath, "utf8"));
  }

  return validateJob(raw);
}
