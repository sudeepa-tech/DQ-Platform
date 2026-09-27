'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path'); const { spawnSync } = require('child_process'); const ENGINE = require('../harness/engine_under_test');
const REPO = path.resolve(__dirname, '..', '..');
test('RT-06 calendar dates are identical under Asia/Kolkata, UTC and America/New_York (timezone matrix, all datasets)', () => {
  const p = spawnSync(process.execPath, ['--experimental-sqlite', path.join(REPO, 'qa/harness/tz_matrix.js'), `--adapter=${ENGINE.ingest}`], { encoding: 'utf8' });
  assert.equal(p.status, 0, '\n' + p.stdout);
});
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]);
const src = walk(path.join(REPO, 'backend/src')).filter(f => f.endsWith('.js'));
test('RT-07 no unbounded array spread into push/Math.max/min (stack-overflow class, audit A12)', () => {
  const hits = []; src.forEach(f => fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (/\.push\(\s*\.\.\./.test(l) || /Math\.(max|min)\(\s*\.\.\./.test(l)) hits.push(`${path.relative(REPO, f)}:${i + 1}: ${l.trim()}`); }));
  assert.deepEqual(hits, [], 'variadic spread of potentially unbounded arrays');
});
test('RT-08 executable production code contains no dataset-specific literals (anti-overfitting guard; comments ignored)', () => {
  const files = [...src, ...walk(path.join(REPO, 'frontend/src'))]; const hits = [];
  files.forEach(f => fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (/^\s*(\/\/|\*|\/\*)/.test(l)) return; if (/ERP_Dump|ERP-0\d|Authenticity|Material_Master_23|Service_Entry_Sheet|holdout|hold-out/i.test(l)) hits.push(`${path.relative(REPO, f)}:${i + 1}`); }));
  assert.deepEqual(hits, []);
});
