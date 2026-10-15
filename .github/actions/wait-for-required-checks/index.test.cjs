// Unit tests for the pure resolution helpers — plain `node index.test.cjs`,
// zero dependencies, wired into pre-commit as a local hook.

"use strict";

const assert = require("node:assert/strict");
const {
  parseNames,
  latestFor,
  classifyLatest,
  newestActivityMs,
  nextLink,
} = require("./index.cjs");

function run(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const completed = (name, conclusion, started_at, completed_at) => ({
  name,
  status: "completed",
  conclusion,
  started_at,
  completed_at: completed_at || started_at,
});
const pending = (name, started_at) => ({
  name,
  status: "in_progress",
  conclusion: null,
  started_at,
});

run("parseNames trims and drops blanks", () => {
  assert.deepEqual(parseNames("  a \n\n b\n"), ["a", "b"]);
  assert.deepEqual(parseNames(undefined), []);
});

run("latestFor picks the newest run by started_at", () => {
  const runs = [
    completed("x", "failure", "2026-01-01T00:00:00Z"),
    completed("x", "success", "2026-01-01T01:00:00Z"),
  ];
  assert.equal(latestFor(runs, "x").conclusion, "success");
});

run("latestFor: a newer skipped run never supersedes a real result", () => {
  // The masking scenario: a batch fails, then an unrelated event (e.g. a
  // label add the workflow triggers on but skips) mints a newer skipped run
  // of the same check on the same SHA. The failure must still win.
  const runs = [
    completed("smoke", "failure", "2026-01-01T00:00:00Z"),
    completed("smoke", "skipped", "2026-01-01T02:00:00Z"),
  ];
  assert.equal(latestFor(runs, "smoke").conclusion, "failure");
});

run("latestFor: a newer real run supersedes an older failure (re-run to green)", () => {
  const runs = [
    completed("smoke", "failure", "2026-01-01T00:00:00Z"),
    completed("smoke", "skipped", "2026-01-01T01:00:00Z"),
    completed("smoke", "success", "2026-01-01T02:00:00Z"),
  ];
  assert.equal(latestFor(runs, "smoke").conclusion, "success");
});

run("latestFor: a pending run counts as real and supersedes a failure", () => {
  const runs = [
    completed("build", "failure", "2026-01-01T00:00:00Z"),
    pending("build", "2026-01-01T01:00:00Z"),
  ];
  assert.equal(latestFor(runs, "build").status, "in_progress");
});

run("latestFor: all-skipped resolves to the skip (draft / path-filter pass)", () => {
  const runs = [
    completed("scan", "skipped", "2026-01-01T00:00:00Z"),
    completed("scan", "skipped", "2026-01-01T01:00:00Z"),
  ];
  assert.equal(latestFor(runs, "scan").conclusion, "skipped");
});

run("latestFor: no runs -> null", () => {
  assert.equal(latestFor([], "x"), null);
});

run("classifyLatest: absent waits inside grace, na after", () => {
  assert.equal(classifyLatest(null, 10, 90).state, "wait");
  assert.equal(classifyLatest(null, 90, 90).state, "na");
});

run("classifyLatest: pass / fail conclusions", () => {
  assert.equal(classifyLatest(completed("x", "success"), 0, 90).state, "pass");
  assert.equal(classifyLatest(completed("x", "skipped"), 0, 90).state, "pass");
  assert.equal(classifyLatest(completed("x", "neutral"), 0, 90).state, "pass");
  assert.equal(classifyLatest(completed("x", "failure"), 0, 90).state, "fail");
  assert.equal(classifyLatest(completed("x", "timed_out"), 0, 90).state, "fail");
  assert.equal(
    classifyLatest(completed("x", "action_required"), 0, 90).state,
    "fail",
  );
});

run("classifyLatest: cancelled gets grace for a superseding run, then fails", () => {
  assert.equal(classifyLatest(completed("x", "cancelled"), 10, 90).state, "wait");
  assert.equal(classifyLatest(completed("x", "cancelled"), 90, 90).state, "fail");
});

run("classifyLatest: pending states wait", () => {
  for (const status of ["queued", "in_progress", "pending", "waiting"]) {
    assert.equal(
      classifyLatest({ name: "x", status, conclusion: null }, 999, 90).state,
      "wait",
    );
  }
});

run("newestActivityMs: newest start/completion across listed names only", () => {
  const runs = [
    completed("listed", "success", "2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z"),
    completed("unlisted", "success", "2026-01-01T09:00:00Z", "2026-01-01T09:05:00Z"),
    pending("listed", "2026-01-01T01:00:00Z"),
  ];
  assert.equal(
    newestActivityMs(runs, ["listed"]),
    Date.parse("2026-01-01T01:00:00Z"),
  );
  assert.equal(newestActivityMs([], ["listed"]), 0);
});

run("newestActivityMs re-arms grace: late-registering matrix run is waited for", () => {
  // The latch scenario: the gate starts with the batch; the matrix build
  // check-runs only register once the detect job completes (say 2 minutes
  // in). Quiet time measured from that completion is ~0s, so an absent
  // matrix name must still be in "wait", not latched not-applicable.
  const detectDone = Date.now() - 5000; // detect completed 5s ago
  const runs = [
    {
      name: "Detect changed images",
      status: "completed",
      conclusion: "success",
      started_at: new Date(detectDone - 120000).toISOString(),
      completed_at: new Date(detectDone).toISOString(),
    },
  ];
  const names = ["Detect changed images", "Build x / Build & Push"];
  const quiet = Math.floor(
    (Date.now() - Math.max(Date.now() - 600000, newestActivityMs(runs, names))) /
      1000,
  );
  assert.equal(classifyLatest(latestFor(runs, names[1]), quiet, 90).state, "wait");
});

run("classifyLatest: a run from an earlier event waits out grace, pass or fail", () => {
  // The first-poll race: the gate re-runs on a title edit (same SHA) and its
  // first poll sees only the previous event's completed runs, before the
  // re-run of the title check registers.
  const edit = Date.parse("2026-01-01T01:00:00Z");
  for (const conclusion of ["success", "failure", "cancelled"]) {
    const stale = completed("title", conclusion, "2026-01-01T00:00:00Z");
    assert.equal(classifyLatest(stale, 10, 90, edit).state, "wait");
  }
  assert.equal(
    classifyLatest(completed("title", "success", "2026-01-01T00:00:00Z"), 90, 90, edit).state,
    "pass",
  );
  assert.equal(
    classifyLatest(completed("title", "failure", "2026-01-01T00:00:00Z"), 90, 90, edit).state,
    "fail",
  );
});

run("classifyLatest: a run from this event (same second or later) is not held", () => {
  const edit = Date.parse("2026-01-01T01:00:00Z");
  assert.equal(
    classifyLatest(completed("title", "failure", "2026-01-01T01:00:00Z"), 0, 90, edit).state,
    "fail",
  );
  assert.equal(
    classifyLatest(completed("title", "success", "2026-01-01T01:00:05Z"), 0, 90, edit).state,
    "pass",
  );
});

run("classifyLatest: without an event time nothing is held", () => {
  const old = completed("title", "success", "2026-01-01T00:00:00Z");
  assert.equal(classifyLatest(old, 0, 90).state, "pass");
  assert.equal(classifyLatest(old, 0, 90, 0).state, "pass");
});

run("latestFor + classifyLatest: the re-run supersedes the held run once registered", () => {
  const edit = Date.parse("2026-01-01T01:00:00Z");
  const runs = [
    completed("title", "success", "2026-01-01T00:00:00Z"),
    pending("title", "2026-01-01T01:00:01Z"),
  ];
  assert.equal(classifyLatest(latestFor(runs, "title"), 10, 90, edit).state, "wait");
  runs[1] = completed("title", "failure", "2026-01-01T01:00:01Z", "2026-01-01T01:00:20Z");
  assert.equal(classifyLatest(latestFor(runs, "title"), 10, 90, edit).state, "fail");
});

run("earlier-event failure + skipped run from this event: held, then still fails", () => {
  // The laundering case: the edit's run of the check skips, so latestFor keeps
  // the earlier failure. Holding it must only delay the failure.
  const edit = Date.parse("2026-01-01T01:00:00Z");
  const runs = [
    completed("title", "failure", "2026-01-01T00:00:00Z"),
    completed("title", "skipped", "2026-01-01T01:00:02Z"),
  ];
  assert.equal(classifyLatest(latestFor(runs, "title"), 10, 90, edit).state, "wait");
  assert.equal(classifyLatest(latestFor(runs, "title"), 90, 90, edit).state, "fail");
});

run("earlier-event cancelled run with no replacement fails after grace", () => {
  const edit = Date.parse("2026-01-01T01:00:00Z");
  const stale = completed("lint", "cancelled", "2026-01-01T00:00:00Z");
  assert.equal(classifyLatest(stale, 90, 90, edit).state, "fail");
});

run("nextLink parses rel=next and returns null otherwise", () => {
  assert.equal(
    nextLink('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"'),
    "https://api.github.com/x?page=2",
  );
  assert.equal(nextLink('<https://api.github.com/x?page=1>; rel="prev"'), null);
  assert.equal(nextLink(null), null);
});

process.exit(process.exitCode || 0);
