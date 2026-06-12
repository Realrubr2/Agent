#!/usr/bin/env node
import { runWorker } from "./worker.js";

runWorker(process.env).catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
