// Wait for required checks — Node implementation of the aggregation gate.
//
// Polls GET /repos/{repo}/commits/{sha}/check-runs and resolves each named
// check to pass / fail / not-applicable, acting as a single-context stand-in
// for many real checks (see README.md).
//
// Zero npm dependencies: uses only Node built-ins (global fetch, node24
// runtime). Entry point for a `using: node24` action; the pure functions are
// exported so they can be unit-tested with plain `node`.

"use strict";

const RESOLVE_PASS = ["success", "skipped", "neutral"];
const PENDING_STATES = ["queued", "in_progress", "pending", "waiting"];

// GitHub workflow command — surfaces as a job annotation.
function annotateError(title, message) {
  console.log(`::error title=${title}::${message}`);
}

// Parse a newline-separated input into a trimmed, de-blanked list.
function parseNames(raw) {
  return String(raw || "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Most-recent check-run for a given name, by started_at (lexical ISO sort).
function latestFor(runs, name) {
  const matches = runs
    .filter((r) => r.name === name)
    .sort((a, b) => (a.started_at || "").localeCompare(b.started_at || ""));
  return matches.length ? matches[matches.length - 1] : null;
}

// Classify the latest run for one required check.
//   { state: "wait" | "pass" | "fail" | "na", detail }
// Pure — no I/O — so the resolution rules are directly testable.
function classifyLatest(run, elapsed, graceSeconds) {
  if (!run) {
    return elapsed < graceSeconds
      ? { state: "wait", detail: `not yet registered (grace ${graceSeconds}s)` }
      : {
          state: "na",
          detail: "absent after grace -> not-applicable (treated as success)",
        };
  }
  const status = run.status;
  const conclusion = run.conclusion || "";
  if (status === "completed") {
    return RESOLVE_PASS.includes(conclusion)
      ? { state: "pass", detail: conclusion }
      : { state: "fail", detail: conclusion };
  }
  if (PENDING_STATES.includes(status)) {
    return { state: "wait", detail: status };
  }
  return { state: "wait", detail: `unknown state: ${status}` };
}

// Extract rel="next" from a Link header, or null.
function nextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

async function fetchJson(url, token, attempt = 1) {
  const MAX_ATTEMPTS = 4;
  let res;
  try {
    res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "wait-for-required-checks",
      },
    });
  } catch (err) {
    if (attempt >= MAX_ATTEMPTS) throw err;
    await sleep(2 ** attempt);
    return fetchJson(url, token, attempt + 1);
  }
  // Retry transient server errors / secondary rate limits.
  if ((res.status >= 500 || res.status === 429) && attempt < MAX_ATTEMPTS) {
    await sleep(2 ** attempt);
    return fetchJson(url, token, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status} for ${url}: ${body.slice(0, 300)}`);
  }
  return { data: await res.json(), link: res.headers.get("link") };
}

async function getCheckRuns(apiUrl, repo, sha, token) {
  const runs = [];
  let url = `${apiUrl}/repos/${repo}/commits/${sha}/check-runs?per_page=100`;
  while (url) {
    const { data, link } = await fetchJson(url, token);
    if (data && Array.isArray(data.check_runs)) runs.push(...data.check_runs);
    url = nextLink(link);
  }
  return runs;
}

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function pad(name) {
  return name.length >= 40 ? name : name + " ".repeat(40 - name.length);
}

async function main() {
  const names = parseNames(process.env["INPUT_REQUIRED-CHECKS"]);
  const graceSeconds = Number(process.env["INPUT_GRACE-SECONDS"] || "90");
  const pollSeconds = Number(process.env["INPUT_POLL-SECONDS"] || "15");
  const maxWaitSeconds = Number(process.env["INPUT_MAX-WAIT-SECONDS"] || "2400");
  const headSha = (process.env["INPUT_HEAD-SHA"] || "").trim();
  const token = process.env["INPUT_GITHUB-TOKEN"] || process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";

  if (!headSha) {
    annotateError(
      "Bad configuration",
      "head-sha is empty — this action only supports pull_request / pull_request_target events.",
    );
    process.exit(1);
  }
  if (names.length === 0) {
    annotateError("Bad configuration", "required-checks input is empty.");
    process.exit(1);
  }
  if (!token) {
    annotateError("Bad configuration", "no github-token available.");
    process.exit(1);
  }

  console.log(`Required checks (${names.length}):`);
  for (const n of names) console.log(`  - ${n}`);
  console.log(`Head SHA: ${headSha}\n`);

  const resolved = new Map();
  const start = Date.now();

  for (;;) {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    const runs = await getCheckRuns(apiUrl, repo, headSha, token);

    let allDone = true;
    for (const name of names) {
      if (resolved.has(name)) continue;

      const { state, detail } = classifyLatest(
        latestFor(runs, name),
        elapsed,
        graceSeconds,
      );
      const line = `[${String(elapsed).padStart(4)}s] ${pad(name)} ${detail}`;

      if (state === "fail") {
        console.log(line);
        annotateError(
          "Required check failed",
          `${name} concluded with ${detail}`,
        );
        process.exit(1);
      }
      if (state === "wait") {
        allDone = false;
      } else {
        // pass | na
        resolved.set(name, state === "na" ? "not-applicable" : `ok (${detail})`);
      }
      console.log(line);
    }

    if (allDone) {
      console.log("\nAll required checks resolved:");
      for (const name of names) console.log(`  ${pad(name)} ${resolved.get(name)}`);
      process.exit(0);
    }

    if (elapsed >= maxWaitSeconds) {
      annotateError(
        "Required checks timed out",
        `elapsed ${elapsed}s exceeded max ${maxWaitSeconds}s`,
      );
      for (const name of names) {
        console.log(`  ${pad(name)} ${resolved.get(name) || "still-pending"}`);
      }
      process.exit(1);
    }

    await sleep(pollSeconds);
  }
}

if (require.main === module) {
  main().catch((err) => {
    annotateError("wait-for-required-checks crashed", String(err && err.message ? err.message : err));
    process.exit(1);
  });
}

module.exports = { parseNames, latestFor, classifyLatest, nextLink };
