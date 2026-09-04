---
name: git
description: Safety rules for destructive git ops. Use before force-push, reset --hard, clean, rebase on shared branches, or remote branch deletion.
---

## Dangerous — confirm with user before running

- `git push --force` / `--force-with-lease` — never on main or shared branches
- `git reset --hard` — discards work, irreversible
- `git clean -fd` — deletes untracked files (dry-run first: `git clean -nd`)
- `git branch -D` — force-delete regardless of merge state
- `git rebase` on pushed branches — rewrites shared history

Never delete branches on remote.
