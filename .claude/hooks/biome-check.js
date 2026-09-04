#!/usr/bin/env node
// PostToolUse hook: run biome check --write on the edited file
import { spawnSync } from "node:child_process";

// Resolve the repo root from this file's own location (.claude/hooks/ → ../..)
// rather than trusting cwd — the Bash tool's cwd persists across calls, so a
// `cd` into any subdirectory would otherwise leave the binary unresolvable.
const REPO_ROOT = new URL("../..", import.meta.url).pathname;

let input = "";
process.stdin.resume();
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let filePath;
  try {
    filePath = JSON.parse(input).tool_input?.file_path;
  } catch {
    process.exit(0);
  }

  if (!filePath) process.exit(0);

  // biome exits non-zero when it finds unfixable issues — don't block Claude
  // Use local binary directly — avoids npx resolution overhead (~200ms)
  spawnSync(
    `${REPO_ROOT}node_modules/.bin/biome`,
    [
      "check",
      "--write",
      "--no-errors-on-unmatched",
      "--files-ignore-unknown=true",
      filePath,
    ],
    { stdio: "inherit" },
  );
});
