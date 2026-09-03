// Claude Desktop session store (CCD).
//
// The desktop keeps its own record of every Claude Code session it tracks under
//   ~/Library/Application Support/Claude/claude-code-sessions/<org>/<ws>/local_<uuid>.json
// Each record maps the desktop's own id (`sessionId`, a `local_<uuid>`) to the
// underlying CLI transcript id (`cliSessionId`), plus title / isArchived / prs.
//
// This matters for two reasons:
//   1. The desktop's deep link (claude://code/continue?session=<id>) matches on
//      the `local_` id, NOT the CLI id — so to jump to a session we must resolve
//      cliSessionId → local id here.
//   2. isArchived is the desktop's real "is this in the sidebar" flag, which our
//      transcript-only view can't otherwise know.
//
// NOTE: on packaged (production) desktop builds the deep-link route is behind a
// remote feature gate and may be disabled — see README. This mapping is still
// correct and future-proof for when it is enabled.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STORE = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');

let cache = { at: 0, byCli: new Map() };

function walk(dir, out, depth = 0) {
  if (depth > 4) return;
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, depth + 1);
    else if (e.name.startsWith('local_') && e.name.endsWith('.json')) out.push(full);
  }
}

// Map cliSessionId → { desktopId, isArchived, title, prs, lastFocusedAt }. Cached 15s.
export function desktopIndex() {
  if (cache.byCli.size && Date.now() - cache.at < 15_000) return cache.byCli;
  const byCli = new Map();
  const files = [];
  walk(STORE, files);
  for (const f of files) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      continue;
    }
    if (!j.cliSessionId || !j.sessionId) continue;
    // If the same CLI session was reopened, keep the most recently active record.
    const prev = byCli.get(j.cliSessionId);
    if (prev && (prev.lastActivityAt || 0) >= (j.lastActivityAt || 0)) continue;
    byCli.set(j.cliSessionId, {
      desktopId: j.sessionId,
      isArchived: !!j.isArchived,
      title: j.title || null,
      prs: Array.isArray(j.prs) ? j.prs : null,
      lastActivityAt: j.lastActivityAt || null,
    });
  }
  cache = { at: Date.now(), byCli };
  return byCli;
}

export function desktopFor(cliId) {
  return desktopIndex().get(cliId) || null;
}
