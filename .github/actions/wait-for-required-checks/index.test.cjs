// Unit tests for the pure helpers in index.cjs. Zero dependencies:
//   node --test .github/actions/wait-for-required-checks/index.test.cjs

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseNames,
  latestFor,
  classifyLatest,
  newestActivityMs,
  nextLink,
} = require("./index.cjs");

const GRACE = 90;
const EVENT_TIME = "2026-10-15T10:00:00Z";
const EVENT_MS = Date.parse(EVENT_TIME);
const BEFORE_EVENT = "2026-10-15T09:59:59Z";
const AFTER_EVENT = "2026-10-15T10:00:01Z";
const LATER = "2026-10-15T10:00:05Z";

function run(conclusion, startedAt, status = "completed") {
  return {
    name: "Syntax Check",
    status,
    conclusion: status === "completed" ? conclusion : null,
    started_at: startedAt,
    completed_at: status === "completed" ? startedAt : null,
  };
}

function classify(runs, quietSeconds, eventTimeMs = EVENT_MS) {
  return classifyLatest(latestFor(runs, "Syntax Check"), quietSeconds, GRACE, eventTimeMs).state;
}

test("skip started after event-time is held during grace", () => {
  assert.equal(classify([run("skipped", AFTER_EVENT)], 0), "wait");
  assert.equal(classify([run("skipped", AFTER_EVENT)], GRACE - 1), "wait");
});

test("skip is held during grace with no event-time", () => {
  assert.equal(classify([run("skipped", AFTER_EVENT)], 0, 0), "wait");
});

test("skip started before event-time is held during grace", () => {
  assert.equal(classify([run("skipped", BEFORE_EVENT)], 0), "wait");
});

test("skip alone passes after grace", () => {
  const result = classifyLatest(run("skipped", AFTER_EVENT), GRACE, GRACE, EVENT_MS);
  assert.deepEqual(result, { state: "pass", detail: "skipped" });
});

test("skip followed by a real success passes on the success", () => {
  const runs = [run("skipped", AFTER_EVENT), run("success", LATER)];
  assert.equal(latestFor(runs, "Syntax Check").conclusion, "success");
  assert.equal(classify(runs, 0), "pass");
});

test("skip followed by a queued real run waits on the real run", () => {
  const runs = [run("skipped", AFTER_EVENT), run(null, LATER, "queued")];
  assert.equal(classify(runs, GRACE), "wait");
});

test("skip followed by a real failure fails", () => {
  assert.equal(classify([run("skipped", AFTER_EVENT), run("failure", LATER)], 0), "fail");
});

test("later skip does not supersede an earlier failure", () => {
  const runs = [run("failure", AFTER_EVENT), run("skipped", LATER)];
  assert.equal(latestFor(runs, "Syntax Check").conclusion, "failure");
  assert.equal(classify(runs, 0), "fail");
});

test("absent check waits during grace, then is not-applicable", () => {
  assert.equal(classify([], 0), "wait");
  assert.equal(classify([], GRACE), "na");
});

test("success started after event-time passes at once", () => {
  assert.equal(classify([run("success", AFTER_EVENT)], 0), "pass");
});

test("neutral started after event-time passes at once", () => {
  assert.equal(classify([run("neutral", AFTER_EVENT)], 0), "pass");
});

test("result from an earlier event is held during grace, then counts", () => {
  assert.equal(classify([run("success", BEFORE_EVENT)], 0), "wait");
  assert.equal(classify([run("success", BEFORE_EVENT)], GRACE), "pass");
  assert.equal(classify([run("failure", BEFORE_EVENT)], 0), "wait");
  assert.equal(classify([run("failure", BEFORE_EVENT)], GRACE), "fail");
});

test("failure started after event-time fails at once", () => {
  assert.equal(classify([run("failure", AFTER_EVENT)], 0), "fail");
  assert.equal(classify([run("timed_out", AFTER_EVENT)], 0), "fail");
});

test("cancelled waits during grace, then fails", () => {
  assert.equal(classify([run("cancelled", AFTER_EVENT)], 0), "wait");
  assert.equal(classify([run("cancelled", AFTER_EVENT)], GRACE), "fail");
});

test("pending states wait", () => {
  for (const status of ["queued", "in_progress", "pending", "waiting"]) {
    assert.equal(classify([run(null, AFTER_EVENT, status)], GRACE), "wait");
  }
});

test("newestActivityMs takes the newest start or completion of listed names", () => {
  const runs = [
    { name: "A", started_at: BEFORE_EVENT, completed_at: AFTER_EVENT },
    { name: "B", started_at: LATER, completed_at: null },
    { name: "Unlisted", started_at: "2026-10-15T11:00:00Z", completed_at: null },
  ];
  assert.equal(newestActivityMs(runs, ["A", "B"]), Date.parse(LATER));
  assert.equal(newestActivityMs([], ["A"]), 0);
});

test("parseNames trims and drops blank lines", () => {
  assert.deepEqual(parseNames("  A \n\n B\n"), ["A", "B"]);
  assert.deepEqual(parseNames(undefined), []);
});

test("nextLink reads rel=next", () => {
  const link = '<https://api/x?page=2>; rel="next", <https://api/x?page=5>; rel="last"';
  assert.equal(nextLink(link), "https://api/x?page=2");
  assert.equal(nextLink('<https://api/x?page=5>; rel="last"'), null);
  assert.equal(nextLink(null), null);
});
