// Zero-dependency syntax check for CI and the pre-commit hook.
//
// This project has no build step and no test framework, so the CI "check" is a
// parse pass: run `node --check` over every first-party .js / .mjs / .cjs file.
// It catches syntax errors before they reach main without pulling in a linter.
// (server.js can't simply be imported — it starts an HTTP listener on load — so
// we parse rather than execute.)

import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['node_modules', '.git', '_design_src', 'scratchpad']);
const EXTS = new Set(['.js', '.mjs', '.cjs']);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (EXTS.has(extname(name))) out.push(full);
  }
  return out;
}

const files = walk(ROOT).sort();
let failed = 0;
for (const f of files) {
  const rel = f.slice(ROOT.length);
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    console.log(`  ok   ${rel}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${rel}`);
    process.stderr.write((e.stderr || Buffer.from('')).toString());
  }
}

console.log(`\nchecked ${files.length} file(s), ${failed} failed`);
process.exit(failed ? 1 : 0);
