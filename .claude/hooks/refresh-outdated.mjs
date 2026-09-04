#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CACHE_PATH = resolve(REPO_ROOT, ".claude/cache/outdated.json");
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const force = process.argv.includes("--force");

if (!force) {
  try {
    const age = Date.now() - statSync(CACHE_PATH).mtimeMs;
    if (age < MAX_AGE_MS) process.exit(0);
  } catch {
    // missing cache — fall through and build it
  }
}

const result = spawnSync(
  "pnpm",
  ["outdated", "--recursive", "--format", "json"],
  { cwd: REPO_ROOT, encoding: "utf8", shell: true, timeout: 60_000 },
);

const stdout = result.stdout?.trim();
if (!stdout) process.exit(0);

let parsed;
try {
  parsed = JSON.parse(stdout);
} catch {
  process.exit(0);
}

mkdirSync(dirname(CACHE_PATH), { recursive: true });
writeFileSync(
  CACHE_PATH,
  JSON.stringify(
    { refreshedAt: new Date().toISOString(), packages: parsed },
    null,
    2,
  ),
);
