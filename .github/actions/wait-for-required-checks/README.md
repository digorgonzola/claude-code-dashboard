# wait-for-required-checks

Node composite-style action (`using: node24`, `index.cjs`) that polls the
GitHub Checks API for a list of named check-run contexts on a pull request's
head SHA. Acts as a single-context aggregator for a branch ruleset, so one
required status (`Required Checks`) can stand in for many real checks —
including ones that don't run on every PR because their source workflow is
gated by `paths:`.

## Why it exists here

**Vendored** into this repo so it has no cross-repo dependency. Being a
same-repo (`$/`) action, it also needs **no** entry in the repo's Actions
allowlist. Implemented in Node (`index.cjs`, zero npm deps, built-in `fetch`)
for readability and testability.

## Why a ruleset needs it

A ruleset that requires a context like `Lint, Type Check & Test` blocks a PR
forever if the source workflow's `on.pull_request.paths` filter excludes that
PR's diff — the workflow never triggers, the context is never registered, and
the ruleset waits indefinitely. This action always runs on every PR and waits
for the named checks to either resolve or fail to appear within a grace window.

## Usage

```yaml
# .github/workflows/required-checks.yml
on:
  pull_request_target:
    branches: [main]

concurrency:
  group: required-checks-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read   # fetch the `$/` action from this repo
  checks: read

jobs:
  required-checks:
    name: Required Checks          # <-- the registered context
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: $/.github/actions/wait-for-required-checks   # base commit under pull_request_target; no checkout
        with:
          required-checks: |
            Lint, Type Check & Test
            Audit workflows
```

Then point the ruleset's `required_status_checks` at the single context
`Required Checks`.

### Why `pull_request_target` + `$/`

`pull_request_target` loads the workflow **and** this action from the base
branch, so a PR cannot tamper with the gate via its own diff. `$/` resolves the
action at the running workflow's commit (the **base** branch), with no checkout,
so no PR code reaches the runner. The action only calls the Checks API for the
head SHA read from the event payload. **Do not** check out
`github.event.pull_request.head.sha` or `run:` any PR code in this job.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `required-checks` | yes | — | Newline-separated check-run names. Match the exact strings shown in the Checks API / ruleset. |
| `grace-seconds` | no | `90` | Seconds of quiet (no start or completion of any listed check) to wait for a check to first appear on the head SHA before treating it as not-applicable. The same window gives a cancelled run time to be superseded and holds an earlier event's result (see below). Raise if your slowest workflow takes longer than this to be queued by GitHub. |
| `poll-seconds` | no | `15` | Seconds between polls. |
| `max-wait-seconds` | no | `2400` | Hard ceiling on total wait time. |
| `head-sha` | no | `${{ github.event.pull_request.head.sha }}` | Commit SHA to read check-runs for. |
| `event-time` | no | `${{ github.event.pull_request.updated_at }}` | Time of the triggering event. A completed run that started before it is from an earlier event on the same SHA and only counts after grace (see below). Empty turns this off. |
| `github-token` | no | `${{ github.token }}` | Token for API calls. Needs `checks: read` (true for the default `GITHUB_TOKEN`). |

## Resolution rules

For each required check, the action picks the most recent matching check-run
(by `started_at`) **that has a real result**. A `skipped` run never supersedes
an earlier genuine result of the same check (a workflow that skips its jobs on
unrelated events must not launder a red check green). Only when every run of a
name is skipped does the skip stand. Grace is measured as *quiet time*: seconds
since the newest start or completion of any listed check (or since the gate
started, whichever is later). A check that registers late, such as a
dynamic-matrix job that cannot exist until its parent completes, re-arms the
window instead of being latched not-applicable. Nothing is latched: every poll
reclassifies every name from the live list.

A gate that re-runs on the same head SHA (here: `ready_for_review`, which adds
no commit) finds the earlier event's completed runs already there. On its first
poll the new run of a listed check may not have registered yet, so the old
result would decide the gate: for example the draft's `skipped` run would pass
it before the real run starts. A completed run that started before
`event-time` is therefore held for the same grace window before its result
counts. The new run supersedes it as soon as it registers. A check that does
not re-run on the event keeps its earlier result once grace elapses. It is
delayed, never dropped.

| Latest real check state | Action |
|---|---|
| Absent, quiet < `grace-seconds` | keep waiting |
| Absent, quiet ≥ `grace-seconds` | not-applicable → success (source `paths` excluded this PR) |
| `queued` / `in_progress` / `pending` / `waiting` | keep waiting |
| `completed`, started before `event-time`, quiet < `grace-seconds` | keep waiting (the run is from an earlier event on this SHA and its re-run may not have registered yet) |
| `completed` + `success` / `skipped` / `neutral` | success |
| `completed` + `cancelled`, quiet < `grace-seconds` | keep waiting (a superseding run usually follows a cancellation) |
| `completed` + `cancelled`, quiet ≥ `grace-seconds` | gate fails, naming the cancelled check |
| `completed` + `failure` / `timed_out` / `action_required` | gate fails immediately, naming the check |
| Total elapsed > `max-wait-seconds` | gate fails (timeout) |

## Testing

`index.cjs` exports its pure helpers (`parseNames`, `latestFor`,
`classifyLatest`, `newestActivityMs`, `nextLink`) and only runs the poll loop when invoked
directly, so the resolution rules can be unit-tested with plain `node` — no
runner required.
