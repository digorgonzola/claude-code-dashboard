#!/usr/bin/env node
// PostToolUse hook: run the STE Simplified-Technical-English linter on prose
// files after a Write/Edit. Advisory only — it never blocks Claude. It reports
// the violations-per-100-words score so slop is visible before it lands.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

// Prose files: lint the whole file. Code files: lint only the comments.
const PROSE = new Set([".md", ".mdx", ".txt"]);
const CODE = new Set([
  ".yml", ".yaml", ".toml", ".sh", ".bash", ".zsh", ".py", ".rb", ".pl",
  ".tf", ".conf", ".cfg", ".ini", ".ts", ".tsx", ".js", ".jsx", ".mjs",
  ".cjs", ".mts", ".cts", ".go", ".rs", ".java", ".kt", ".c", ".cc",
  ".cpp", ".h", ".hpp", ".css", ".scss", ".less", ".swift", ".php",
]);
// Files with no extension that are still comment-bearing.
const CODE_NAMES = new Set(["dockerfile", "makefile"]);

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

  const ext = extname(filePath).toLowerCase();
  const base = filePath.split("/").pop().toLowerCase();
  const isProse = PROSE.has(ext);
  const isCode = CODE.has(ext) || CODE_NAMES.has(base) || base.startsWith("dockerfile");
  if (!isProse && !isCode) process.exit(0);

  const linter = join(dirname(fileURLToPath(import.meta.url)), "ste-lint.py");
  const args = isCode ? [linter, "--comments", filePath] : [linter, filePath];
  const res = spawnSync("python3", args, { encoding: "utf8" });
  if (res.status !== 0 || !res.stdout) process.exit(0);

  const line = res.stdout.trim();
  const scope = isCode ? "comments" : "prose";
  // Feed the score back to Claude as context, without blocking the edit.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `STE lint (${scope}, lower is better): ${line}`,
      },
    }),
  );
  process.exit(0);
});
