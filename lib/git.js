// Optional live PR state via the `gh` CLI. On-demand and cached, because a
// `gh pr view` per session per poll would be far too slow. The transcript's
// pr-link record already gives us number/url/repo for free; this only adds the
// current state (open / merged / closed) and CI rollup when the drawer asks.

import { execFile } from 'node:child_process';

const cache = new Map(); // `${repo}#${number}` -> { at, data }
const TTL = 30_000;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout);
    });
  });
}

export async function getPrState(repo, number) {
  if (!repo || !number) return null;
  const key = `${repo}#${number}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;

  const out = await run('gh', [
    'pr', 'view', String(number),
    '--repo', repo,
    '--json', 'state,isDraft,mergeable,statusCheckRollup,title,url,additions,deletions,changedFiles',
  ]);
  let data = null;
  if (out) {
    try {
      const j = JSON.parse(out);
      const checks = Array.isArray(j.statusCheckRollup) ? j.statusCheckRollup : [];
      const failing = checks.filter((c) => (c.conclusion || c.state) && /FAIL|ERROR/i.test(c.conclusion || c.state)).length;
      const pending = checks.filter((c) => /PENDING|IN_PROGRESS|QUEUED/i.test(c.status || c.state || '')).length;
      data = {
        state: j.state,               // OPEN | MERGED | CLOSED
        isDraft: j.isDraft,
        title: j.title,
        url: j.url,
        changedFiles: j.changedFiles,
        additions: j.additions,
        deletions: j.deletions,
        checks: { total: checks.length, failing, pending },
      };
    } catch {
      data = null;
    }
  }
  cache.set(key, { at: Date.now(), data });
  return data;
}
