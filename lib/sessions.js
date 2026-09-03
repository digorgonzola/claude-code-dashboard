// Discovery and interpretation of real Claude Code sessions on this machine.
//
// Sources of truth (all local, read-only):
//   ~/.claude/sessions/<pid>.json   — the live-session registry. Claude Code
//                                      writes one file per running process with
//                                      { pid, sessionId, cwd, startedAt, name }.
//   ~/.claude/projects/<enc>/<id>.jsonl — the append-only transcript for a
//                                      session, where <enc> is the cwd with
//                                      "/" and "." replaced by "-".
//
// A session is "live" when its registry file's pid is still a running process.
// Everything else (repo, branch, model, cost, PR, status) is derived from the
// transcript. Status is a heuristic — see classifyStatus() — because Claude Code
// does not persist an explicit "waiting for permission" flag to disk.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { costOfUsage, modelLabel } from './pricing.js';
import { desktopFor } from './desktop.js';

const HOME = os.homedir();
const SESSIONS_DIR = path.join(HOME, '.claude', 'sessions');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');

// Timing windows for the status heuristic.
export const RUNNING_WINDOW_MS = 15_000;   // transcript touched this recently → actively working
export const STALE_WINDOW_MS = 120_000;    // no sync in this long → flag the card as stale
export const IDLE_WINDOW_MS = 10 * 60_000; // finished a turn this long ago → idle, not awaiting

// ── tiny caches ──────────────────────────────────────────────────────────────
const parseCache = new Map();   // path -> { key, data }
let indexCache = { at: 0, map: null };

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but owned by another user
  }
}

// Map every sessionId on disk to its transcript file. Cached for 8s.
function transcriptIndex() {
  if (indexCache.map && Date.now() - indexCache.at < 8000) return indexCache.map;
  const map = new Map();
  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    /* no projects dir */
  }
  for (const d of projectDirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, d.name);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -6);
      const full = path.join(dir, f);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      map.set(id, { path: full, dir: d.name, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  indexCache = { at: Date.now(), map };
  return map;
}

// Derive a "owner/repo" + short repo + worktree from a cwd, honoring the
// ~/.claude/worktrees convention that puts worktrees under the repo root.
function repoInfo(cwd, prRepository) {
  if (!cwd) return { repo: prRepository ? prRepository.split('/').pop() : 'unknown', owner: null, worktree: null, isWorktree: false };
  let root = cwd;
  let isWorktree = false;
  const marker = '/.claude/worktrees/';
  const idx = cwd.indexOf(marker);
  if (idx !== -1) {
    root = cwd.slice(0, idx);
    isWorktree = true;
  }
  const repo = path.basename(root);
  const worktree = isWorktree ? path.basename(cwd) : null;
  const owner = prRepository && prRepository.includes('/') ? prRepository.split('/')[0] : null;
  return { repo, owner, worktree, isWorktree };
}

function textOfBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && b.text)
    .map((b) => b.text)
    .join(' ')
    .trim();
}

// A one-line hint describing a pending tool call, e.g. "Bash · npm test".
function toolHint(block) {
  if (!block || block.type !== 'tool_use') return null;
  const name = block.name || 'tool';
  const inp = block.input || {};
  let detail = '';
  if (typeof inp.command === 'string') detail = inp.command;
  else if (typeof inp.file_path === 'string') detail = inp.file_path;
  else if (typeof inp.path === 'string') detail = inp.path;
  else if (typeof inp.pattern === 'string') detail = inp.pattern;
  else if (typeof inp.url === 'string') detail = inp.url;
  else if (typeof inp.description === 'string') detail = inp.description;
  detail = String(detail).replace(/\s+/g, ' ').trim();
  return { name, detail: detail.slice(0, 80) };
}

// Parse a transcript into a compact summary. Cached on (mtime,size) so an
// unchanged file is never re-read.
function parseTranscript(entry) {
  const key = `${entry.mtimeMs}:${entry.size}`;
  const cached = parseCache.get(entry.path);
  if (cached && cached.key === key) return cached.data;

  let raw = '';
  try {
    raw = fs.readFileSync(entry.path, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n');

  const d = {
    title: null,
    lastPrompt: null,
    cwd: null,
    model: null,
    branch: null,
    pr: null,
    cost: 0,
    assistantTurns: 0,
    userTurns: 0,
    firstTs: null,
    lastTs: null,
    // tail state for classification
    lastMeaningfulRole: null,   // 'assistant' | 'user'
    pendingTool: null,          // { name, detail } when last assistant turn is an unanswered tool call
    lastAssistantStop: null,
    lastAssistantText: '',
    lastAskedQuestion: false,
    tail: [],                   // last N simplified records for the detail drawer
  };

  const tailBuf = [];
  for (const line of lines) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.gitBranch) d.branch = o.gitBranch;
    if (o.cwd && !d.cwd) d.cwd = o.cwd;
    if (o.timestamp) {
      if (!d.firstTs) d.firstTs = o.timestamp;
      d.lastTs = o.timestamp;
    }
    switch (o.type) {
      case 'custom-title':
        if (o.customTitle) d.title = o.customTitle;
        break;
      case 'last-prompt':
        if (o.lastPrompt) d.lastPrompt = o.lastPrompt;
        break;
      case 'pr-link':
        d.pr = { number: o.prNumber, url: o.prUrl, repository: o.prRepository };
        break;
      case 'assistant': {
        const msg = o.message || {};
        if (msg.model) d.model = msg.model;
        if (msg.usage) d.cost += costOfUsage(msg.usage, msg.model);
        d.assistantTurns++;
        const text = textOfBlocks(msg.content);
        const toolBlocks = Array.isArray(msg.content) ? msg.content.filter((b) => b && b.type === 'tool_use') : [];
        d.lastMeaningfulRole = 'assistant';
        d.lastAssistantStop = msg.stop_reason || null;
        if (text) {
          d.lastAssistantText = text;
          d.lastAskedQuestion = /\?\s*$/.test(text.trim());
        }
        // A tool_use turn is "pending" until a following user tool_result arrives.
        if (msg.stop_reason === 'tool_use' && toolBlocks.length) {
          d.pendingTool = toolHint(toolBlocks[toolBlocks.length - 1]);
        } else {
          d.pendingTool = null;
        }
        tailBuf.push({ role: 'assistant', text: (text || (toolBlocks[0] ? `⛭ ${toolBlocks.map((b) => b.name).join(', ')}` : '')).slice(0, 240), ts: o.timestamp });
        break;
      }
      case 'user': {
        const msg = o.message || {};
        const content = msg.content;
        const isToolResult = Array.isArray(content) && content.some((b) => b && b.type === 'tool_result');
        if (isToolResult) {
          // Claude's tool ran; it is no longer parked on a permission prompt.
          d.pendingTool = null;
          d.lastMeaningfulRole = 'user';
        } else {
          const text = textOfBlocks(content);
          if (text) {
            d.userTurns++;
            d.lastMeaningfulRole = 'user';
            tailBuf.push({ role: 'user', text: text.slice(0, 240), ts: o.timestamp });
          }
        }
        break;
      }
      default:
        break;
    }
  }
  d.tail = tailBuf.slice(-40);
  const data = d;
  parseCache.set(entry.path, { key, data });
  return data;
}

// The status heuristic. Honest about what it can and can't know from disk.
export function classifyStatus(parsed, mtimeMs) {
  const age = Date.now() - mtimeMs;
  const fresh = age < RUNNING_WINDOW_MS;

  if (parsed.pendingTool) {
    // An unanswered tool call. Fresh → the tool is executing; stale → almost
    // always parked on a permission prompt waiting for the human.
    if (fresh) {
      return { status: 'running', reason: `Running · ${parsed.pendingTool.name}`, attention: false };
    }
    const t = parsed.pendingTool;
    const detail = t.detail ? `${t.name} · ${t.detail}` : t.name;
    return { status: 'waiting', reason: `Needs permission · ${detail}`, attention: true, kind: 'permission' };
  }

  if (parsed.lastMeaningfulRole === 'assistant' && parsed.lastAssistantStop === 'end_turn') {
    if (fresh) return { status: 'running', reason: 'Finishing up…', attention: false };
    if (age < IDLE_WINDOW_MS) {
      return parsed.lastAskedQuestion
        ? { status: 'waiting', reason: 'Asked you a question', attention: true, kind: 'question' }
        : { status: 'waiting', reason: 'Awaiting your reply', attention: true, kind: 'reply' };
    }
    return { status: 'idle', reason: 'Idle — turn complete', attention: false };
  }

  // Last record is a user/tool_result, or an unusual tail.
  if (fresh) return { status: 'running', reason: 'Working…', attention: false };
  if (age < IDLE_WINDOW_MS) return { status: 'running', reason: 'Thinking…', attention: false };
  return { status: 'idle', reason: 'Idle', attention: false };
}

function shorten(str, n) {
  if (!str) return '';
  const s = String(str).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Build the full live-session list.
export function getLiveSessions() {
  const index = transcriptIndex();
  let files = [];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    /* none */
  }

  const sessions = [];
  for (const f of files) {
    let reg;
    try {
      reg = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
    } catch {
      continue;
    }
    if (!reg.pid || !isPidAlive(reg.pid)) continue;

    const entry = index.get(reg.sessionId);
    const parsed = entry ? parseTranscript(entry) : null;
    const mtimeMs = entry ? entry.mtimeMs : reg.startedAt || Date.now();
    const cls = parsed
      ? classifyStatus(parsed, mtimeMs)
      : { status: 'running', reason: 'Starting…', attention: false };

    const cwd = reg.cwd || (parsed && parsed.cwd) || '';
    const pr = parsed && parsed.pr;
    const ri = repoInfo(cwd, pr && pr.repository);
    const title =
      (parsed && parsed.title) ||
      shorten(parsed && parsed.lastPrompt, 90) ||
      reg.name ||
      ri.repo;

    const desk = desktopFor(reg.sessionId);
    sessions.push({
      id: reg.sessionId,
      desktopId: desk && desk.desktopId,
      live: true,
      pid: reg.pid,
      name: reg.name || null,
      kind: reg.kind || 'interactive',
      entrypoint: reg.entrypoint || null,
      cwd,
      repo: ri.repo,
      owner: ri.owner,
      worktree: ri.worktree,
      isWorktree: ri.isWorktree,
      branch: (parsed && parsed.branch) || null,
      title,
      lastMessage: shorten((parsed && parsed.lastAssistantText) || (parsed && parsed.lastPrompt), 120),
      model: (parsed && parsed.model) || null,
      modelLabel: modelLabel(parsed && parsed.model),
      status: cls.status,
      statusReason: cls.reason,
      attention: cls.attention,
      attentionKind: cls.kind || null,
      cost: parsed ? parsed.cost : 0,
      messages: parsed ? parsed.assistantTurns + parsed.userTurns : 0,
      startedAt: reg.startedAt || null,
      lastActivity: parsed ? parsed.lastTs : null,
      lastActivityMs: mtimeMs,
      ageMs: Date.now() - mtimeMs,
      stale: Date.now() - mtimeMs > STALE_WINDOW_MS,
      pr: pr || null,
    });
  }

  // Attention first, then most-recently-active.
  sessions.sort((a, b) => {
    if (a.attention !== b.attention) return a.attention ? -1 : 1;
    return b.lastActivityMs - a.lastActivityMs;
  });
  return sessions;
}

// "Open" sessions: recently-active transcripts with no live process. These are
// what Claude Desktop keeps in its sidebar (getAllSessions filtered to
// non-archived) — resumable, but not currently running. We can't read the
// desktop's archive flag from disk, so we approximate "open" as active within
// `openDays`, capped per repo to keep the list as dense as the sidebar.
export function getOpenSessions(liveIds, openDays = 7, perRepoCap = 15) {
  const cutoff = Date.now() - openDays * 86_400_000;
  const index = transcriptIndex();
  const entries = [...index.entries()]
    .filter(([id, e]) => !liveIds.has(id) && e.mtimeMs >= cutoff)
    .sort((a, b) => b[1].mtimeMs - a[1].mtimeMs);

  const perRepo = new Map();
  const out = [];
  for (const [id, entry] of entries) {
    const parsed = parseTranscript(entry);
    if (!parsed || parsed.assistantTurns + parsed.userTurns === 0) continue;
    const ri = repoInfo(parsed.cwd, parsed.pr && parsed.pr.repository);
    const n = perRepo.get(ri.repo) || 0;
    if (n >= perRepoCap) continue;
    perRepo.set(ri.repo, n + 1);

    const ageMs = Date.now() - entry.mtimeMs;
    const reason = parsed.pendingTool
      ? `Paused mid-task · ${parsed.pendingTool.name}`
      : parsed.lastAskedQuestion
        ? 'Left with a question'
        : 'Not running';
    const desk = desktopFor(id);
    out.push({
      id,
      desktopId: desk && desk.desktopId,
      live: false,
      pid: null,
      name: null,
      kind: 'open',
      entrypoint: null,
      cwd: parsed.cwd || '',
      repo: ri.repo,
      owner: ri.owner,
      worktree: ri.worktree,
      isWorktree: ri.isWorktree,
      branch: parsed.branch || null,
      title: parsed.title || shorten(parsed.lastPrompt, 90) || ri.repo,
      lastMessage: shorten(parsed.lastAssistantText || parsed.lastPrompt, 120),
      model: parsed.model || null,
      modelLabel: modelLabel(parsed.model),
      status: 'open',
      statusReason: reason,
      attention: false,
      attentionKind: null,
      cost: parsed.cost,
      messages: parsed.assistantTurns + parsed.userTurns,
      startedAt: parsed.firstTs ? new Date(parsed.firstTs).getTime() : null,
      lastActivity: parsed.lastTs,
      lastActivityMs: entry.mtimeMs,
      ageMs,
      stale: false,
      pr: parsed.pr || null,
    });
  }
  return out;
}

// Live sessions plus (optionally) the desktop's broader "open" set.
export function getSessions(opts = {}) {
  const { includeOpen = true, openDays = 7, perRepoCap = 15 } = opts;
  const live = getLiveSessions();
  if (!includeOpen) return live;
  const liveIds = new Set(live.map((s) => s.id));
  const open = getOpenSessions(liveIds, openDays, perRepoCap);
  // Live first (already attention-sorted), then open by recency.
  return [...live, ...open];
}

// A single session's transcript tail for the detail drawer.
export function getSessionDetail(id) {
  const entry = transcriptIndex().get(id);
  if (!entry) return null;
  const parsed = parseTranscript(entry);
  if (!parsed) return null;
  return { id, tail: parsed.tail, title: parsed.title, lastPrompt: shorten(parsed.lastPrompt, 400) };
}

export { transcriptIndex, parseTranscript, isPidAlive, repoInfo, SESSIONS_DIR, PROJECTS_DIR };
