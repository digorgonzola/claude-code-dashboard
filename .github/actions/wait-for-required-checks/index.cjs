// Wait for required checks — Node implementation of the aggregation gate.
//
// Polls GET /repos/{repo}/commits/{sha}/check-runs and resolves each named
// check to pass / fail / not-applicable, acting as a single-context stand-in
// for many real checks (see README.md).
//
// Zero npm dependencies: uses only Node built-ins (global fetch, node24
// runtime). Entry point for a `using: node24` action; the pure functions are
// exported so they can be unit-tested with plain `node` (see index.test.cjs).

"use strict";

const RESOLVE_PASS = ["success", "skipped", "neutral"];
const PENDING_STATES = ["queued", "in_progress", "pending", "waiting"];
// ISO 8601 with an explicit zone, as GitHub emits it. Date.parse alone also
// accepts "1" or a zone-less time read as runner-local.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

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

// Most-recent check-run for a given name, by started_at (lexical ISO sort) —
// preferring runs with a real result. A `skipped` run only ever means "this
// event was not for me" (a job-level `if` that didn't match), so it must
// never supersede an earlier genuine failure of the same check: a workflow
// that skips its jobs on unrelated events (e.g. a label add) would otherwise
// launder a red check green. Only when every run of the name is skipped does
// the skip itself stand (the ordinary draft/path-filter pass).
function latestFor(runs, name) {
  const matches = runs
    .filter((r) => r.name === name)
    .sort((a, b) => (a.started_at || "").localeCompare(b.started_at || ""));
  if (!matches.length) return null;
  const real = matches.filter(
    (r) => !(r.status === "completed" && r.conclusion === "skipped"),
  );
  return real.length ? real[real.length - 1] : matches[matches.length - 1];
}

// Newest activity timestamp (ms epoch) across every run of the listed names:
// the quiet-period clock for classifyLatest. Any start or completion of a
// listed check re-arms the grace window, so a check whose run only comes into
// existence late — a dynamic-matrix job that cannot register until its parent
// completes — is still waited for, instead of being latched not-applicable at
// a fixed offset from the gate's own start.
function newestActivityMs(runs, names) {
  let newest = 0;
  for (const r of runs) {
    if (!names.includes(r.name)) continue;
    for (const ts of [r.started_at, r.completed_at]) {
      const ms = ts ? Date.parse(ts) : NaN;
      if (!Number.isNaN(ms) && ms > newest) newest = ms;
    }
  }
  return newest;
}

// Classify the latest run for one required check.
//   { state: "wait" | "pass" | "fail" | "na", detail }
// quietSeconds is the time since the newest activity on ANY listed check (or
// since the gate started, whichever is later) — not simple elapsed time — so
// grace measures "nothing is happening", not "the gate has been up a while".
// `cancelled` gets the same grace as absence before failing: a cancellation
// is usually a superseded batch whose replacement run is about to register,
// and the replacement (a newer non-skipped run) then takes over.
// A completed run that started before eventTimeMs (the event that triggered
// this gate) belongs to an earlier event on the same SHA — e.g. the gate
// re-runs on a PR title edit — and its re-run may not have registered yet at
// the first poll. Its result, pass or fail, gets the same grace before it
// counts, so the gate neither passes on a stale green nor fails on a stale
// red that the edit fixed. Pure — no I/O — so the resolution rules are
// directly testable.
function classifyLatest(run, quietSeconds, graceSeconds, eventTimeMs = 0) {
  if (!run) {
    return quietSeconds < graceSeconds
      ? { state: "wait", detail: `not yet registered (grace ${graceSeconds}s)` }
      : {
          state: "na",
          detail: "absent after grace -> not-applicable (treated as success)",
        };
  }
  const status = run.status;
  const conclusion = run.conclusion || "";
  if (status === "completed") {
    if (quietSeconds < graceSeconds && Date.parse(run.started_at) < eventTimeMs) {
      return {
        state: "wait",
        detail: `${conclusion || "completed"} from an earlier event (grace ${graceSeconds}s for a re-run)`,
      };
    }
    if (RESOLVE_PASS.includes(conclusion)) {
      return { state: "pass", detail: conclusion };
    }
    if (conclusion === "cancelled") {
      return quietSeconds < graceSeconds
        ? { state: "wait", detail: `cancelled (grace ${graceSeconds}s for a superseding run)` }
        : { state: "fail", detail: "cancelled" };
    }
    return { state: "fail", detail: conclusion };
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
  const eventTime = (process.env["INPUT_EVENT-TIME"] || "").trim();
  const eventTimeMs = ISO_TIMESTAMP.test(eventTime) ? Date.parse(eventTime) : 0;
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
  if (eventTime && !eventTimeMs) {
    annotateError("Bad configuration", `event-time is not an ISO 8601 timestamp with a zone: ${eventTime}`);
    process.exit(1);
  }

  console.log(`Required checks (${names.length}):`);
  for (const n of names) console.log(`  - ${n}`);
  console.log(`Head SHA: ${headSha}`);
  console.log(`Event time: ${eventTime || "(none; earlier-event runs are not held)"}\n`);

  // No per-name latching: every poll reclassifies every name from the live
  // check-run list, so a check that registers late (dynamic matrix), or a
  // cancelled run superseded by its replacement, is picked up on the next
  // poll. `lastPrinted` only de-duplicates the log.
  const lastPrinted = new Map();
  const start = Date.now();

  for (;;) {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    const runs = await getCheckRuns(apiUrl, repo, headSha, token);
    const quietSeconds = Math.floor(
      (Date.now() - Math.max(start, newestActivityMs(runs, names))) / 1000,
    );

    const states = new Map();
    for (const name of names) {
      const { state, detail } = classifyLatest(
        latestFor(runs, name),
        quietSeconds,
        graceSeconds,
        eventTimeMs,
      );
      states.set(name, { state, detail });

      const line = `[${String(elapsed).padStart(4)}s] ${pad(name)} ${detail}`;
      if (lastPrinted.get(name) !== detail) {
        console.log(line);
        lastPrinted.set(name, detail);
      }

      if (state === "fail") {
        annotateError(
          "Required check failed",
          `${name} concluded with ${detail}`,
        );
        process.exit(1);
      }
    }

    if ([...states.values()].every(({ state }) => state !== "wait")) {
      console.log("\nAll required checks resolved:");
      for (const name of names) {
        const { state, detail } = states.get(name);
        console.log(
          `  ${pad(name)} ${state === "na" ? "not-applicable" : `ok (${detail})`}`,
        );
      }
      process.exit(0);
    }

    if (elapsed >= maxWaitSeconds) {
      annotateError(
        "Required checks timed out",
        `elapsed ${elapsed}s exceeded max ${maxWaitSeconds}s`,
      );
      for (const name of names) {
        const { state, detail } = states.get(name);
        console.log(`  ${pad(name)} ${state === "wait" ? "still-pending" : detail}`);
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

module.exports = { parseNames, latestFor, classifyLatest, newestActivityMs, nextLink };
