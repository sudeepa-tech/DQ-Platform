'use strict';
/* node qa/harness/run_regression.js [--out=qa/baseline/legacy/regression_status.json] : runs qa/regression/*.test.js, parses TAP, prints a compact status table. */
const { spawnSync } = require('child_process'); const fs = require('fs'); const path = require('path'); const REPO = path.resolve(__dirname, '..', '..');
const a = Object.fromEntries(process.argv.slice(2).map(s => s.replace(/^--/, '').split('=')));
const files = fs.readdirSync(path.join(REPO, 'qa/regression')).filter(f => /^rt\d+.*\.test\.js$/.test(f)).sort().map(f => path.join('qa/regression', f));
const p = spawnSync(process.execPath, ['--experimental-sqlite', '--test', '--test-reporter=tap', ...files], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 900000 });
const lines = p.stdout.split('\n'), tests = []; let cur = null;
for (let i = 0; i < lines.length; i++) { const m = /^(\s*)(not ok|ok) \d+ - (.+?)(?: # (SKIP|TODO)\b.*)?$/.exec(lines[i]); if (m) { const name = m[3].trim(); if (/^(RT-\d+|GOLD:)/.test(name)) { cur = { name, status: m[4] ? m[4].toLowerCase() : m[2] === 'ok' ? 'pass' : 'FAIL', reason: '' }; tests.push(cur); } else cur = null; continue; }
  if (cur && cur.status === 'FAIL' && !cur.reason && /^\s+error: /.test(lines[i])) { const buf = []; for (let j = i + 1; j < lines.length && !/^\s+(code|stack|name|duration_ms|failureType):|^\s+\.\.\.$/.test(lines[j]) && buf.length < 6; j++) { const t = lines[j].trim(); if (t && !/^(\+ actual|Expected values to be strictly equal:)/.test(t)) buf.push(t); } cur.reason = buf.join(' | ').slice(0, 420); } }
const cnt = s => tests.filter(t => t.status === s).length; const out = { engine_under_test: { ...require('./engine_under_test'), semantic_profiler: 'legacy_v0', matching: 'legacy_v0', rules_scoring: 'legacy_v0' }, total: tests.length, pass: cnt('pass'), fail: cnt('FAIL'), todo: cnt('todo'), skip: cnt('skip'), tests };
if (a.out) fs.writeFileSync(path.join(REPO, a.out), JSON.stringify(out, null, 1));
for (const t of tests) console.log(`${t.status.padEnd(5)} ${t.name.slice(0, 118)}${t.status === 'FAIL' && t.reason ? '\n        ↳ ' + t.reason.slice(0, 330) : ''}`);
console.log(`\nTOTAL ${out.total}: pass ${out.pass} | FAIL ${out.fail} | todo(contract pending) ${out.todo} | skipped ${out.skip}`); process.exit(out.fail ? 1 : 0);
