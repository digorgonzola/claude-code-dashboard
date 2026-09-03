# wait-for-required-checks

Node composite-style action (`using: node24`, `index.cjs`) that polls the
GitHub Checks API for a list of named check-run contexts on a pull request's
head SHA. Acts as a single-context aggregator for a branch ruleset, so one
required status (`Required Checks`) can stand in for many real checks —
including ones that don't run on every PR because their source workflow is
gated by `paths:`.

## Why it exists here

**Vendored** from the `irt-flight-manager` repo (itself adapted from an
internal reusable action in a private org) so this repo has no cross-repo
dependency. Being a local (`./`) action, it also needs **no** entry in the
repo's Actions allowlist. Implemented in Node (`index.cjs`, zero npm deps,
built-in `fetch`) for readability and testability.

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
  contents: read   # checkout the base-branch copy of this action
  checks: read

jobs:
  required-checks:
    name: Required Checks          # <-- the registered context
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@<sha>   # base ref under pull_request_target
        with:
          persist-credentials: false
          sparse-checkout: .github/actions/wait-for-required-checks
          sparse-checkout-cone-mode: false
      - uses: ./.github/actions/wait-for-required-checks
        with:
          required-checks: |
            Lint, Type Check & Test
            Audit workflows
```

Then point the ruleset's `required_status_checks` at the single context
`Required Checks`.

### Why `pull_request_target` + base checkout

`pull_request_target` loads the workflow **and** this action from the base
branch, so a PR cannot tamper with the gate via its own diff. The checkout uses
`pull_request_target`'s default ref (the **base** branch), so it pulls trusted
code, never the PR head. The action itself does no checkout of PR code — it
only calls the Checks API for the head SHA read from the event payload. **Do
not** check out `github.event.pull_request.head.sha` or `run:` any PR code in
this job.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `required-checks` | yes | — | Newline-separated check-run names. Match the exact strings shown in the Checks API / ruleset. |
| `grace-seconds` | no | `90` | Seconds to wait for a check to first appear on the head SHA before treating it as not-applicable. Raise if your slowest workflow takes longer than this to be queued by GitHub. |
| `poll-seconds` | no | `15` | Seconds between polls. |
| `max-wait-seconds` | no | `2400` | Hard ceiling on total wait time. |
| `head-sha` | no | `${{ github.event.pull_request.head.sha }}` | Commit SHA to read check-runs for. |
| `github-token` | no | `${{ github.token }}` | Token for API calls. Needs `checks: read` (true for the default `GITHUB_TOKEN`). |

## Resolution rules

For each required check, the action picks the most recent matching check-run
(by `started_at`) and applies:

| Latest check state | Action |
|---|---|
| Absent, elapsed < `grace-seconds` | keep waiting |
| Absent, elapsed ≥ `grace-seconds` | not-applicable → success (source `paths` excluded this PR) |
| `queued` / `in_progress` / `pending` / `waiting` | keep waiting |
| `completed` + `success` / `skipped` / `neutral` | success |
| `completed` + `failure` / `cancelled` / `timed_out` / `action_required` | gate fails immediately, naming the check |
| Total elapsed > `max-wait-seconds` | gate fails (timeout) |

## Testing

`index.cjs` exports its pure helpers (`parseNames`, `latestFor`,
`classifyLatest`, `nextLink`) and only runs the poll loop when invoked
directly, so the resolution rules can be unit-tested with plain `node` — no
runner required.
