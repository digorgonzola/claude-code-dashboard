# Claude Code Sessions Dashboard

A live dashboard for every Claude Code session running on this machine — an
action queue you can't miss, status you can trust, cost, and PR state at a
glance. It reads the real session state Claude Code already writes to
`~/.claude`; nothing is mocked.

Built from the **"Organic"** Claude Design system (Caprasimo + Figtree, a warm
cream ground, a terracotta accent for _needs-you_ and a sage accent for
_running_) and the `Sessions Dashboard Wireframes` — specifically the wireframe's
recommended **option 2b**: a triage queue on top of an all-sessions roster.

## Run

No dependencies, no build step. Requires Node 18+.

```bash
node server.js
# → http://localhost:4317
```

Then open <http://localhost:4317>. `PORT=... node server.js` to change the port.

### With Docker

```bash
docker compose up
# → open http://localhost:4317
```

Your host `~/.claude` is mounted read-only so the container has real session
state to show. Override the port or the mounted directory without editing the
compose file:

```bash
PORT=4318 docker compose up
CLAUDE_DIR=/path/to/.claude docker compose up
```

The read-only dashboard, usage and history all work in the container. The write
actions (Kill, Reveal folder, Resume in terminal, Open in desktop) act on host
processes and macOS apps and are not available from inside the container.

## What it shows

| View | What it is |
| --- | --- |
| **Sessions** | The action queue (every session waiting on you, with _why_) over a roster of all live sessions, grouped by repo, with status, model, freshness, elapsed time, cost and PR. |
| **Usage** | Spend over the last 7/30 days — daily chart, by repository, by model — computed from token usage across every transcript. |
| **History** | Recently-ended sessions with outcome and cost. |
| **Settings** | Refresh controls, plus an honest explainer of how every status is derived. |

Click any session to open a drawer with its recent transcript, its live PR
state (via `gh`), and one-click ways back into it. **Open in Claude Desktop**
uses the desktop's own `claude://code/continue?session=<id>` scheme, and **Copy
resume** gives you the `claude --resume` command for a terminal.

> **Note on Open in Claude Desktop.** The desktop keys its sessions by a
> `local_<uuid>` id (stored under `~/Library/Application Support/Claude/claude-code-sessions/`),
> not the CLI transcript id — the dashboard resolves that mapping so the link
> targets the right session. **However**, on packaged (production) desktop
> builds the jump-to-session route is behind a remote feature gate
> (`claudeURLHandler: code entry deep link gated off`). While it's gated, the
> button reliably **foregrounds** Claude Desktop but may not navigate to the
> exact chat; once the gate is enabled it will, with no change here. Sessions
> started directly from the CLI (never registered with the desktop) have no
> `local_` id and can't be targeted — use **Copy resume** for those.

### Live vs. open

The roster shows two kinds of session, matching what Claude Desktop lists:

- **Live** — a Claude Code process is actually running right now
  (`~/.claude/sessions/<pid>.json` with an alive PID). These get real
  running / waiting / idle status and can be killed.
- **Open** — a recently-active session with no running process. Resumable, and
  what the desktop keeps in its sidebar. Because the desktop's archive flag
  isn't written to disk, "open" is approximated as _active within the last 7
  days_, capped per repo, so the list matches the sidebar's breadth. Open
  sessions never enter the action queue (there's no process to answer).

## How it works

Everything is local and read-only except two explicit, guarded actions.

### Session discovery

- **Live sessions** come from `~/.claude/sessions/<pid>.json` — Claude Code
  writes one file per running process (`pid`, `sessionId`, `cwd`, `startedAt`,
  `name`). A session is _live_ when its `pid` is still a running process.
- **Everything else** (repo, branch, model, cost, PR, status) is derived from
  that session's transcript at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
- Repos follow the `~/.claude/worktrees` convention: a worktree's repo is the
  path segment before `/.claude/worktrees/`.

### Status (a heuristic — and it says so)

Claude Code does not persist an explicit "waiting for permission" flag to disk,
so status is inferred from the tail of the transcript plus its modified time:

- **Waiting on you** — the last turn is an unanswered tool call that has sat
  idle (almost always a permission prompt), _or_ Claude ended its turn and is
  awaiting your reply / answering a question.
- **Running** — the transcript was written to within the last 15 seconds.
- **Idle** — a live process with no transcript activity for over 10 minutes.

Because disk state can't tell a permission prompt from a slow tool with
certainty, approving/replying still happens **in the session**. **Go to session**
copies the exact `cd <cwd> && claude --resume <id>` command to get you there.

### Cost

Computed from each transcript's token usage at Anthropic list prices
(Opus $5/$25, Sonnet 5 $2/$10, Fable $10/$50 per 1M in/out), with cache writes
at 1.25× and cache reads at 0.1× the input rate. It's an estimate of
API-equivalent spend, not a bill. Priced per assistant turn at that turn's own
model, so a session that switched models is costed correctly.

### Actions

- **Open in Claude Desktop** — `open claude://code/continue?session=<id>&source=desktop_action`.
  The session id is validated (`[0-9a-f-]{8,64}`) before it's put in the URL.
  Works for live _and_ open sessions.
- **Resume in terminal** (macOS) — resumes the session in your **default terminal
  app**. The server writes a small executable `.command` file
  (`cd <cwd> && exec claude --resume <id>`, with `claude` resolved to an absolute
  path) and `open`s it, so macOS launches whatever app owns shell scripts —
  Terminal, iTerm2, Warp, … — rather than hard-coding Terminal.app. The drawer's
  **Run** button (next to the copied command) does the same thing.
- **Reveal folder** — opens the session's working directory in Finder.
- **Kill** (live only) — `SIGTERM` to a session's process. Guarded (only a pid
  the dashboard currently lists as live) and confirmed in a dialog.

Approving permissions or sending replies _in place_ is intentionally **not**
wired: it would require driving Claude Code's undocumented per-session IPC
socket (`messagingSocketPath`), and getting it wrong could inject bad input into
real, running work. Instead, one click takes you into the actual session — in
the desktop app or a terminal — where you answer it yourself.

## Layout

```
server.js            zero-dependency HTTP server + JSON API + static host
lib/
  sessions.js        live-session discovery, transcript parsing, status heuristic
  analytics.js       usage aggregation + history
  pricing.js         model pricing + cost from token usage
  git.js             live PR state via `gh` (on-demand, cached)
public/
  index.html         app shell
  app.js             the SPA (Sessions / Usage / History / Settings + drawer)
  dashboard.css      app layout — reads only Organic tokens
  organic.css        the Organic design system, vendored verbatim
  icons.js           inlined Lucide icons (the system's icon family)
```

## API

| Endpoint | Returns |
| --- | --- |
| `GET /api/state?open=1&days=7` | live + open sessions and summary counts |
| `GET /api/usage?days=7\|30` | spend over time, by repo, by model |
| `GET /api/history` | recently-ended sessions |
| `GET /api/session/:id` | transcript tail |
| `GET /api/pr?repo=&number=` | live PR state via `gh` |
| `POST /api/action` | `{action:'open-desktop', id}` · `{action:'open-terminal', id, cwd}` (macOS) · `{action:'reveal', cwd}` · `{action:'kill', pid}` |

## Performance

Transcripts are parsed once and cached on `(mtime, size)`, so unchanged files
are never re-read. Usage aggregation only touches files modified within the
selected window and is memoised for 60s. The UI polls `/api/state` every 5s
(configurable in Settings) and pauses polling when the tab is hidden.
