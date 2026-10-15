# wait-for-required-checks

Node action (`using: node24`, `index.cjs`, zero npm dependencies) that polls
the GitHub Checks API for a list of named check-run contexts on a pull
request's head SHA. Acts as a single-context aggregator for branch protection
/ repository rulesets, so that one required status (e.g. `Required Checks`)
can stand in for many real checks -- including ones that may not run on every
PR because their source workflow is gated by `paths:`.

## Why

A repository ruleset that requires a context like `Lint, Type Check & Test`
will block a PR forever if the source workflow's `on.pull_request.paths:`
filter excludes that PR's diff -- the workflow never triggers, the context is
never registered, and the ruleset waits indefinitely.

This action sidesteps that by always running on every PR (no `paths:` filter on
the caller workflow) and waiting for the named checks to either resolve or
fail to appear within a grace window.

## Usage

```yaml
# .github/workflows/required.yml in a consuming repo
name: Required Checks

on:
  pull_request_target:
    branches: [main]

concurrency:
  group: required-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  checks: read
  pull-requests: read
  contents: read

jobs:
  required-checks:
    name: Required Checks    # <-- this string is the registered context
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: isw-kudos/github-actions/.github/actions/wait-for-required-checks@wait-for-required-checks-v1.0.0
        with:
          required-checks: |
            Lint, Type Check & Test
            Docker Build / Build & Push
```

Then point the branch ruleset's `required_status_checks` at the single context
`Required Checks` (or whatever the gate job's `name:` resolves to).

### Why `pull_request_target`

Use `pull_request_target` rather than `pull_request` so the gate workflow is
loaded from the base branch (e.g. `main`) and a PR cannot disable, rename, or
otherwise tamper with the gate by editing the workflow file in the PR diff.

Because this action only reads the Checks API for the head SHA -- no checkout,
no execution of PR code -- it is safe to run under `pull_request_target`.
**Do not** add `actions/checkout` of `${{ github.event.pull_request.head.sha }}`
or any other step that runs PR-supplied code in the same job.

Note: under `pull_request_target`, `github.ref` is the base branch ref, so use
`github.event.pull_request.number` for the `concurrency.group` -- otherwise
all PRs share a group and cancel each other.

**Do not** add a `paths:` filter to the caller workflow. The whole point is
that the gate runs on every PR.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `required-checks` | yes | -- | Newline-separated list of check-run names. Match the exact strings shown in the ruleset's `required_status_checks` -- for reusable workflows that's the composite `<caller-job> / <called-job>` form. |
| `grace-seconds` | no | `90` | Seconds to wait for a check to first appear on the head SHA before treating it as not-applicable. Bump this if your slowest workflow can take longer than 90s to be queued by GitHub. |
| `poll-seconds` | no | `15` | Seconds between polls of the Checks API. |
| `max-wait-seconds` | no | `2400` | Hard ceiling on total wait time. |
| `head-sha` | no | `${{ github.event.pull_request.head.sha }}` | Commit SHA to read check-runs for. |
| `event-time` | no | `${{ github.event.pull_request.updated_at }}` | Time of the triggering event. A completed run that started before it is from an earlier event on the same SHA and only counts after grace (see below). Empty turns this off. |
| `github-token` | no | `${{ github.token }}` | Token used for Checks API calls. Needs `checks: read` (already true for the default `GITHUB_TOKEN`). |

## Resolution rules

For each required check, the action picks the most recent matching check-run
(sorted by `started_at`) **that has a real result** -- a `skipped` run never
supersedes an earlier genuine result of the same check (a workflow that skips
its jobs on unrelated events, e.g. a label add, must not launder a red check
green); only when every run of a name is skipped does the skip stand. Grace is
measured as *quiet time*: seconds since the newest start or completion of any
listed check (or since the gate started, whichever is later), so a check that
registers late -- a dynamic-matrix job that cannot exist until its parent
completes -- re-arms the window instead of being latched not-applicable.
Nothing is latched: every poll reclassifies every name from the live list.

A gate that re-runs on the same head SHA (for example on `edited`, because a
listed check re-runs when the PR title changes) finds the earlier event's
completed runs already there. On its first poll the re-run of a listed check
may not have registered yet, so the old result would decide the gate: a stale
green passes a title that the new run will reject, and a stale red fails a
title the edit fixed. A completed run that started before `event-time` is
therefore held for the same grace window before its result counts; the re-run
supersedes it as soon as it registers. A check that does not re-run on the
event keeps its earlier result once grace elapses -- it is delayed, never
dropped.

| Latest real check state | Action |
|---|---|
| Absent, quiet < `grace-seconds` | keep waiting |
| Absent, quiet >= `grace-seconds` | treat as not-applicable (success) -- source workflow's `paths:` excluded this PR |
| `queued` / `in_progress` / `pending` / `waiting` | keep waiting |
| `completed`, started before `event-time`, quiet < `grace-seconds` | keep waiting -- the run is from an earlier event on this SHA and its re-run may not have registered yet |
| `completed` + `success` / `skipped` / `neutral` | success |
| `completed` + `cancelled`, quiet < `grace-seconds` | keep waiting -- a superseding run usually follows a cancellation |
| `completed` + `cancelled`, quiet >= `grace-seconds` | gate fails, naming the cancelled check |
| `completed` + `failure` / `timed_out` / `action_required` | gate fails immediately, naming the failed check |
| Total elapsed > `max-wait-seconds` | gate fails with a timeout error |

### Listed checks must run on draft PRs

Because `skipped` and "absent after grace" both resolve as success, the gate is
only as strong as the source workflows' willingness to run. A source workflow
gated with `if: github.event.pull_request.draft == false` registers a `skipped`
run on a draft PR, the gate passes for that head SHA, and `ready_for_review` is
not a default `pull_request_target` activity type -- so nothing re-evaluates
when the PR is marked ready. Adding `ready_for_review` to the gate's `types:`
only closes this for a source workflow that itself re-runs on
`ready_for_review` (the new run is a real result and supersedes the skip); a
workflow that stays silent on that event still resolves to its completed
`skipped` run.

**Do not draft-gate (or otherwise conditionally skip) any workflow whose check
is listed in `required-checks`.** Path filters on the source workflow's `on:`
are fine -- that is the not-applicable case this action exists to handle.

## Testing

`index.cjs` exports its pure helpers (`parseNames`, `latestFor`,
`classifyLatest`, `newestActivityMs`, `nextLink`) and only runs the poll loop
when invoked directly. `index.test.cjs` covers the resolution rules with plain
`node` -- no runner, no dependencies -- and runs in pre-commit.
