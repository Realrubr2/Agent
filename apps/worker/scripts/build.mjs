#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(workerRoot, "src");
const distDir = path.join(workerRoot, "dist");

fs.rmSync(distDir, { recursive: true, force: true });
copyDir(srcDir, distDir);

function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true });

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetName = entry.isFile() && entry.name.endsWith(".ts")
      ? `${entry.name.slice(0, -3)}.js`
      : entry.name;
    const targetPath = path.join(target, targetName);

    if (entry.isDirectory()) {
      copyDir(sourcePath, targetPath);
      continue;
    }

    fs.copyFileSync(sourcePath, targetPath);
  }
}
