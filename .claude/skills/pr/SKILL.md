---
name: pr
description: Open a PR with standard What/Why/Changes/Testing/Risks/Deployment template. Use when work is ready to merge and a PR doesn't exist yet.
allowed-tools: Bash(gh pr create *)
---

Check branch clean, open PR.

## Writing

Write the PR title and every prose section (What / Why / Changes / Testing / Risks / Deployment) in Simplified Technical English. Apply the [`ste`](../ste/SKILL.md) skill in STE-flavored mode: active voice, one idea per sentence, max ~20 words, no marketing adjectives, no semicolons, no contractions. Keep code, identifiers, commands, and file paths verbatim.

Before you call `gh pr create`, run the self-lint checklist from the `ste` skill over the body text. To get a numeric score, pipe the drafted body through the linter:

```bash
python3 .claude/hooks/ste-lint.py < /tmp/pr-body.md
```

Lower `total_per100w` is better. Fix the flagged sentences, then open the PR.

A PreToolUse gate (`.claude/hooks/ste-pr-gate.js`) also lints the `--body` of any `gh pr create` / `gh pr edit` / `gh api ... pulls PATCH`. It blocks the call when the score is over `STE_PR_MAX` (default 10). Rewrite and retry, or prefix `STE_PR_GATE=off` for one call.

## Pre-flight

Behind main? Rebase onto it (keeps linear history):
```bash
git fetch origin && git rebase origin/main
```
Resolve conflicts if any, then continue: `git rebase --continue`.

If branch already pushed, force-push with lease (never plain `--force`):
```bash
git push --force-with-lease
```

## Open PR

First push (new branch):
```bash
git push -u origin <branch>
gh pr create --title "<title>" --body "$(cat <<'EOF'
## What


## Why


## Changes
- 

## Testing
- 

## Risks
- 

## Deployment
- 
EOF
)"
```

## Edit existing PR description

Always use API:

```bash
gh api repos/{owner}/{repo}/pulls/<number> --method PATCH --field body="..."
```

Verify after:
```bash
gh pr view <number> --json body -q .body | head -5
```
