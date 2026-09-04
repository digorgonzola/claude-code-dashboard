#!/usr/bin/env node
// PreToolUse hook (Bash): hard STE gate on PR text.
//
// When Claude runs `gh pr create` / `gh pr edit` / a `gh api ... pulls PATCH`,
// this hook extracts the PR body, lints it with ste-lint.py, and BLOCKS the
// call (exit 2) when the slop score is over the threshold. Claude then sees the
// score plus sample violations and revises the body before it retries.
//
// Threshold: env STE_PR_MAX (violations per 100 words), default 10.
// Bypass: set STE_PR_GATE=off.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MAX = Number(process.env.STE_PR_MAX ?? 10);

let input = "";
process.stdin.resume();
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  if (process.env.STE_PR_GATE === "off") process.exit(0);

  let cmd;
  try {
    const p = JSON.parse(input);
    if (p.tool_name !== "Bash") process.exit(0);
    cmd = p.tool_input?.command ?? "";
  } catch {
    process.exit(0);
  }

  // Only gate PR-writing commands.
  const isPr = /\bgh\s+pr\s+(create|edit)\b/.test(cmd);
  const isApiPatch = /\bgh\s+api\b/.test(cmd) && /pulls\//.test(cmd) && /PATCH/.test(cmd);
  if (!isPr && !isApiPatch) process.exit(0);

  const body = extractBody(cmd);
  if (!body || !body.trim()) process.exit(0); // nothing to lint

  const linter = join(dirname(fileURLToPath(import.meta.url)), "ste-lint.py");
  const res = spawnSync("python3", [linter], { input: body, encoding: "utf8" });
  if (res.status !== 0 || !res.stdout) process.exit(0); // linter missing → do not block

  let r;
  try {
    r = JSON.parse(res.stdout);
  } catch {
    process.exit(0);
  }

  if (r.total_per100w <= MAX) process.exit(0); // pass

  const worst = Object.entries(r.violations)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
  const samples = [...(r.sample_banned || []), ...(r.sample_marketing || [])];

  process.stderr.write(
    `STE gate BLOCKED this PR body.\n` +
      `Slop score ${r.total_per100w}/100w exceeds the max of ${MAX}.\n` +
      `Top violations: ${worst}.\n` +
      (samples.length ? `Flagged words: ${samples.join(", ")}.\n` : "") +
      `Rewrite the body in Simplified Technical English (apply the ste skill), then retry.\n` +
      `Override for one call by prefixing STE_PR_GATE=off.\n`,
  );
  process.exit(2); // block, feed stderr back to Claude
});

function extractBody(cmd) {
  const anchor = cmd.search(/--body\b/);
  if (anchor >= 0) {
    const after = cmd.slice(anchor);
    // heredoc: --body "$(cat <<'EOF' ... EOF)"
    const hd = after.match(/<<-?\s*['"]?([A-Za-z_]\w*)['"]?\r?\n([\s\S]*?)\r?\n[ \t]*\1\b/);
    if (hd) return hd[2];
    // --body "..." or --body '...'
    const dq = after.match(/--body(?:=|\s+)"((?:[^"\\]|\\.)*)"/);
    if (dq) return dq[1].replace(/\\"/g, '"');
    const sq = after.match(/--body(?:=|\s+)'([^']*)'/);
    if (sq) return sq[1];
  }
  // --body-file PATH (not stdin "-")
  const bf = cmd.match(/--body-file(?:=|\s+)(\S+)/);
  if (bf && bf[1] !== "-") {
    try {
      return readFileSync(bf[1].replace(/^["']|["']$/g, ""), "utf8");
    } catch {
      /* ignore */
    }
  }
  // gh api --field body="..." / -f body='...'
  const fdq = cmd.match(/(?:--field|-f)\s+body=("(?:[^"\\]|\\.)*")/);
  if (fdq) return fdq[1].slice(1, -1).replace(/\\"/g, '"');
  const fsq = cmd.match(/(?:--field|-f)\s+body=('[^']*')/);
  if (fsq) return fsq[1].slice(1, -1);
  return null;
}
