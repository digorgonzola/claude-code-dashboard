#!/usr/bin/env node
// SessionStart hook: warn when a git worktree hasn't been bootstrapped.
// Detection only — scripts/worktree-init.mjs does the work, so session start
// stays instant. See CLAUDE.md "Git Worktrees".
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// In a worktree .git is a file (`gitdir: …`); in the main checkout, a directory.
const dotGit = resolve(REPO_ROOT, ".git");
if (!existsSync(dotGit) || statSync(dotGit).isDirectory()) process.exit(0);

const missing = [["node_modules", "node_modules"]].flatMap(([label, path]) =>
  existsSync(resolve(REPO_ROOT, path)) ? [] : [label],
);

if (missing.length === 0) process.exit(0);

console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `This worktree is not bootstrapped (missing: ${missing.join(", ")}). Run \`pnpm install\` before any pnpm command.`,
    },
  }),
);
