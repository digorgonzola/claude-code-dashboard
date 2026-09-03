// Claude Code Sessions Dashboard — server.
//
// Zero dependencies: Node's built-in http/fs only. Serves a JSON API backed by
// real on-disk Claude Code session state, plus the static Organic-styled UI.
//
//   GET  /api/state            live sessions + summary counts
//   GET  /api/usage?days=7|30  spend over time, by repo, by model
//   GET  /api/history          recently-ended sessions
//   GET  /api/session/:id      transcript tail (+ live PR state if it has a PR)
//   GET  /api/pr?repo=&number= live PR state via gh
//   POST /api/action           { action:'kill'|'reveal', pid, cwd } — real, guarded
//
// All reads are local and read-only. The only mutations are POST /api/action,
// which are user-initiated from the UI and guarded (kill only targets a pid the
// dashboard currently lists as live).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { getSessions, getLiveSessions, getSessionDetail, STALE_WINDOW_MS } from './lib/sessions.js';
import { getUsage, getHistory, getCostToday } from './lib/analytics.js';
import { getPrState } from './lib/git.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = process.env.PORT || 4317;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function buildSummary(sessions) {
  const s = { total: sessions.length, live: 0, waiting: 0, running: 0, idle: 0, open: 0, attention: 0, stale: 0, costLive: 0 };
  for (const x of sessions) {
    s[x.status] = (s[x.status] || 0) + 1;
    if (x.live) s.live++;
    if (x.attention) s.attention++;
    if (x.stale) s.stale++;
    s.costLive += x.cost;
  }
  return s;
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const filePath = path.join(PUBLIC, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    // No caching: this is a live local dashboard under active iteration — always
    // serve the current CSS/JS so edits show up on a plain reload.
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (p === '/api/state') {
      const includeOpen = url.searchParams.get('open') !== '0';
      const openDays = Number(url.searchParams.get('days')) || 7;
      const sessions = getSessions({ includeOpen, openDays });
      return sendJson(res, 200, {
        sessions,
        summary: { ...buildSummary(sessions), costToday: getCostToday(), staleWindowMs: STALE_WINDOW_MS },
        generatedAt: new Date().toISOString(),
      });
    }

    if (p === '/api/usage') {
      const days = url.searchParams.get('days') === '30' ? 30 : 7;
      return sendJson(res, 200, getUsage(days));
    }

    if (p === '/api/history') {
      return sendJson(res, 200, getHistory(40));
    }

    if (p.startsWith('/api/session/')) {
      const id = p.slice('/api/session/'.length);
      const detail = getSessionDetail(id);
      if (!detail) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, detail);
    }

    if (p === '/api/pr') {
      const repo = url.searchParams.get('repo');
      const number = url.searchParams.get('number');
      const state = await getPrState(repo, number);
      return sendJson(res, 200, { state });
    }

    if (p === '/api/action' && req.method === 'POST') {
      const body = await readBody(req);
      return handleAction(body, res);
    }

    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'unknown endpoint' });

    return serveStatic(req, res);
  } catch (err) {
    return sendJson(res, 500, { error: String(err && err.message ? err.message : err) });
  }
});

// Best-effort absolute path to the `claude` binary, from the server's PATH
// (the user launched `node server.js` from their shell, so it's usually present).
// Falls back to the bare name, in which case the .command sources the profile.
let _claudeBin = null;
function resolveClaudeBin() {
  if (_claudeBin) return _claudeBin;
  try {
    _claudeBin = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim() || 'claude';
  } catch {
    _claudeBin = 'claude';
  }
  return _claudeBin;
}

// Real, guarded mutations.
function handleAction(body, res) {
  const { action } = body;

  if (action === 'kill') {
    const pid = Number(body.pid);
    // Guard: only kill a pid the dashboard currently lists as a live session.
    const live = getLiveSessions().some((s) => s.pid === pid);
    if (!live) return sendJson(res, 400, { ok: false, error: 'pid is not a live dashboard session' });
    try {
      process.kill(pid, 'SIGTERM');
      return sendJson(res, 200, { ok: true, action, pid });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e.message) });
    }
  }

  if (action === 'reveal') {
    const cwd = String(body.cwd || '');
    if (!cwd || !fs.existsSync(cwd)) return sendJson(res, 400, { ok: false, error: 'no such directory' });
    execFile('open', [cwd], () => {});
    return sendJson(res, 200, { ok: true, action, cwd });
  }

  if (action === 'open-terminal') {
    // macOS: resume a session in the user's default terminal. We write a small
    // executable .command file and `open` it — macOS launches whatever app is
    // associated with shell scripts (Terminal, iTerm2, Warp, …), so it honors
    // the user's default terminal rather than hard-coding Terminal.app.
    if (process.platform !== 'darwin') return sendJson(res, 400, { ok: false, error: 'open-terminal is macOS-only' });
    const id = String(body.id || '');
    if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) return sendJson(res, 400, { ok: false, error: 'invalid session id' });
    // Guard: resuming a session that already has a running process conflicts.
    if (getLiveSessions().some((x) => x.id === id)) {
      return sendJson(res, 409, { ok: false, error: 'session is running — stop it before resuming in a terminal' });
    }
    const cwd = String(body.cwd || '');
    const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    const claude = resolveClaudeBin();
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const needPath = claude === 'claude'; // couldn't resolve an absolute path → load the user's PATH
    const script =
      `#!/bin/zsh\n` +
      (needPath ? `[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" 2>/dev/null\n` : '') +
      `cd ${q(dir)} 2>/dev/null\n` +
      `exec ${q(claude)} --resume ${id}\n`;
    const file = path.join(os.tmpdir(), `ccd-resume-${id}.command`);
    try {
      fs.writeFileSync(file, script, { mode: 0o755 });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e.message) });
    }
    execFile('open', [file], () => {});
    return sendJson(res, 200, { ok: true, action, dir });
  }

  if (action === 'open-desktop') {
    // Deep-link into Claude Desktop, the same scheme its own recent-session list
    // uses: claude://code/continue?session=<desktop local_ id>. The desktop keys
    // on the local_ id (not the CLI transcript id), so callers should pass the
    // resolved desktopId. Firing the link foregrounds the app; whether it also
    // navigates to the session depends on a desktop feature gate (see README).
    const id = String(body.id || '');
    if (!/^(local_)?[0-9a-fA-F-]{8,64}$/.test(id)) return sendJson(res, 400, { ok: false, error: 'invalid session id' });
    const link = `claude://code/continue?session=${id}&source=desktop_action`;
    execFile('open', [link], (err) => {
      // Guarantee the app at least comes forward even if the URL is a no-op.
      if (err) execFile('open', ['-a', 'Claude'], () => {});
    });
    return sendJson(res, 200, { ok: true, action, link });
  }

  return sendJson(res, 400, { ok: false, error: 'unknown action' });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  The dashboard may already be running — open http://localhost:${PORT}`);
    console.error(`  Or free the port:  kill $(lsof -ti tcp:${PORT})`);
    console.error(`  Or use another:    PORT=4318 node server.js\n`);
    process.exit(1);
  }
  console.error('Server error:', err.message);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`\n  Claude Code Sessions Dashboard`);
  console.log(`  → http://localhost:${PORT}\n`);
});
