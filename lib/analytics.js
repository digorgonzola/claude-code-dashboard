// Historical aggregation across every transcript on disk: spend over time, spend
// by repo and by model (the Usage screen), and recently-ended sessions (History).
//
// Bounded and cached: only files modified within the requested window are read,
// and results are memoised for 60s so repeated polls are cheap.

import fs from 'node:fs';
import path from 'node:path';
import { costOfUsage, modelLabel } from './pricing.js';
import {
  transcriptIndex,
  parseTranscript,
  isPidAlive,
  repoInfo,
  SESSIONS_DIR,
} from './sessions.js';
import { desktopFor } from './desktop.js';

const usageCache = new Map(); // range(days) -> { at, data }

function dayKey(ts) {
  return ts.slice(0, 10); // YYYY-MM-DD
}

// Set of sessionIds backed by a still-running process.
function liveSessionIds() {
  const ids = new Set();
  let files = [];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return ids;
  }
  for (const f of files) {
    try {
      const reg = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      if (reg.pid && isPidAlive(reg.pid) && reg.sessionId) ids.add(reg.sessionId);
    } catch {
      /* skip */
    }
  }
  return ids;
}

// Aggregate spend for the last `days` days.
export function getUsage(days = 7) {
  const cached = usageCache.get(days);
  if (cached && Date.now() - cached.at < 60_000) return cached.data;

  const cutoff = Date.now() - days * 86_400_000;
  const index = transcriptIndex();
  const perDay = new Map();   // YYYY-MM-DD -> { cost, tokens, sessions:Set }
  const perRepo = new Map();  // repo -> cost
  const perModel = new Map(); // model -> cost
  let totalCost = 0;
  let totalTokens = 0;
  const activeSessions = new Set();

  for (const [id, entry] of index) {
    if (entry.mtimeMs < cutoff) continue; // untouched in window → nothing to count
    let raw;
    try {
      raw = fs.readFileSync(entry.path, 'utf8');
    } catch {
      continue;
    }
    let repo = 'unknown';
    let fileCostInWindow = 0;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.cwd && repo === 'unknown') repo = repoInfo(o.cwd).repo;
      if (o.type !== 'assistant' || !o.message || !o.message.usage) continue;
      const ts = o.timestamp;
      if (!ts || new Date(ts).getTime() < cutoff) continue;
      const u = o.message.usage;
      const model = o.message.model;
      const c = costOfUsage(u, model);
      const tokens = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      const dk = dayKey(ts);
      if (!perDay.has(dk)) perDay.set(dk, { cost: 0, tokens: 0, sessions: new Set() });
      const day = perDay.get(dk);
      day.cost += c;
      day.tokens += tokens;
      day.sessions.add(id);
      perModel.set(model || 'unknown', (perModel.get(model || 'unknown') || 0) + c);
      totalCost += c;
      totalTokens += tokens;
      fileCostInWindow += c;
    }
    if (fileCostInWindow > 0) {
      perRepo.set(repo, (perRepo.get(repo) || 0) + fileCostInWindow);
      activeSessions.add(id);
    }
  }

  // Build a dense day series (fill gaps with zero).
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const dk = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    const day = perDay.get(dk);
    series.push({ date: dk, cost: day ? day.cost : 0, tokens: day ? day.tokens : 0, sessions: day ? day.sessions.size : 0 });
  }

  const data = {
    range: days,
    totalCost,
    totalTokens,
    sessionCount: activeSessions.size,
    series,
    byRepo: [...perRepo.entries()].map(([repo, cost]) => ({ repo, cost })).sort((a, b) => b.cost - a.cost).slice(0, 8),
    byModel: [...perModel.entries()].map(([model, cost]) => ({ model, label: modelLabel(model), cost })).sort((a, b) => b.cost - a.cost),
    generatedAt: new Date().toISOString(),
  };
  usageCache.set(days, { at: Date.now(), data });
  return data;
}

// Spend for the current calendar day (used by the header "$X today").
export function getCostToday() {
  const u = getUsage(1);
  const today = new Date().toISOString().slice(0, 10);
  const day = u.series.find((d) => d.date === today);
  return day ? day.cost : 0;
}

// Recently-ended sessions: transcripts with no live process, newest first.
export function getHistory(limit = 30) {
  const live = liveSessionIds();
  const index = transcriptIndex();
  const rows = [];
  const entries = [...index.entries()].filter(([id]) => !live.has(id));
  entries.sort((a, b) => b[1].mtimeMs - a[1].mtimeMs);

  for (const [id, entry] of entries.slice(0, limit)) {
    const parsed = parseTranscript(entry);
    if (!parsed || (!parsed.lastTs && !parsed.title)) continue;
    const ri = repoInfo(deriveCwd(entry), parsed.pr && parsed.pr.repository);
    let outcome = 'ended';
    if (parsed.pr) outcome = 'pr';
    else if (parsed.assistantTurns === 0) outcome = 'empty';
    const desk = desktopFor(id);
    rows.push({
      id,
      desktopId: desk && desk.desktopId,
      repo: ri.repo,
      worktree: ri.worktree,
      branch: parsed.branch,
      title: parsed.title || shorten(parsed.lastPrompt, 80) || ri.repo,
      model: parsed.model,
      modelLabel: modelLabel(parsed.model),
      cost: parsed.cost,
      messages: parsed.assistantTurns + parsed.userTurns,
      endedAt: parsed.lastTs,
      endedAtMs: entry.mtimeMs,
      outcome,
      pr: parsed.pr,
    });
  }
  return { rows, generatedAt: new Date().toISOString() };
}

function deriveCwd(entry) {
  // Reverse the "/"+"."→"-" encoding well enough to name the repo. We only need
  // the repo segment, so reading the first cwd from the file is most reliable.
  try {
    const raw = fs.readFileSync(entry.path, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        if (o.cwd) return o.cwd;
      } catch {
        /* skip */
      }
    }
  } catch {
    /* ignore */
  }
  return '';
}

function shorten(str, n) {
  if (!str) return '';
  const s = String(str).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
