#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CACHE_PATH = resolve(REPO_ROOT, ".claude/cache/outdated.json");
const REFRESH_SCRIPT = resolve(REPO_ROOT, ".claude/hooks/refresh-outdated.mjs");
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

let input = "";
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  let filePath;
  try {
    filePath = JSON.parse(input).tool_input?.file_path;
  } catch {
    process.exit(0);
  }
  if (!filePath) process.exit(0);

  const rel = relative(REPO_ROOT, filePath);
  if (!isTargetFile(rel)) process.exit(0);

  maybeRefreshCacheInBackground();

  const cache = loadCache();
  if (!cache) process.exit(0);

  const entries = rel.endsWith("pnpm-workspace.yaml")
    ? parseCatalog(filePath)
    : parsePackageJson(filePath);

  const flagged = [];
  for (const [name, version] of entries) {
    if (!isComparableRange(version)) continue;
    const info = cache.packages[name];
    if (!info?.latest) continue;
    const currentMajor = majorOf(version);
    const latestMajor = majorOf(info.latest);
    if (currentMajor == null || latestMajor == null) continue;
    if (latestMajor > currentMajor) {
      flagged.push({
        name,
        version,
        latest: info.latest,
        delta: latestMajor - currentMajor,
      });
    }
  }

  if (flagged.length > 0) {
    const lines = [`⚠ Outdated versions in ${rel}:`];
    for (const f of flagged) {
      lines.push(
        `  - ${f.name}: ${f.version} → ${f.latest} available (${f.delta} major behind)`,
      );
    }
    lines.push(
      "Suggestion: bump to latest major if compatible, or pin exact version to silence this warning.",
    );
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: lines.join("\n"),
        },
      })}\n`,
    );
  }
});

function isTargetFile(rel) {
  if (rel === "pnpm-workspace.yaml") return true;
  if (!rel.endsWith("/package.json")) return false;
  return (
    rel.startsWith("apps/") ||
    rel.startsWith("packages/") ||
    rel === "package.json"
  );
}

function loadCache() {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function maybeRefreshCacheInBackground() {
  try {
    const age = Date.now() - statSync(CACHE_PATH).mtimeMs;
    if (age < MAX_AGE_MS) return;
  } catch {
    // no cache yet — kick off a build
  }
  const child = spawn("node", [REFRESH_SCRIPT], {
    detached: true,
    stdio: "ignore",
    cwd: REPO_ROOT,
  });
  child.unref();
}

function parsePackageJson(filePath) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
  const out = [];
  for (const section of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
  ]) {
    const block = pkg[section];
    if (!block) continue;
    for (const [name, version] of Object.entries(block)) {
      if (typeof version === "string") out.push([name, version]);
    }
  }
  return out;
}

function parseCatalog(filePath) {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n");
  const out = [];
  let inCatalog = false;
  for (const raw of lines) {
    if (/^catalog:\s*$/.test(raw)) {
      inCatalog = true;
      continue;
    }
    if (inCatalog) {
      if (/^\S/.test(raw)) break; // dedent — end of catalog block
      const m = raw.match(
        /^\s+["']?([^"'\s:]+)["']?\s*:\s*["']?([^"'\s#]+)["']?/,
      );
      if (m) out.push([m[1], m[2]]);
    }
  }
  return out;
}

function isComparableRange(version) {
  const v = version.trim();
  if (!v) return false;
  if (/^(workspace|catalog|link|file|portal|github|git\+|npm):/.test(v))
    return false;
  if (v === "*" || v === "latest") return false;
  if (v.startsWith("http")) return false;
  if (v.includes("/")) return false; // git shorthand like user/repo
  if (/\s|\|\|/.test(v)) return false; // complex range
  if (/^[<>=]/.test(v)) return false;
  if (v.startsWith("^") || v.startsWith("~")) return true;
  return false; // exact pin → intentional, skip
}

function majorOf(version) {
  const m = version.match(/(\d+)\./);
  return m ? Number(m[1]) : null;
}
