'use strict';
/* P0 requires 2k, 5k and 10k to pass. This regression file runs the 2k gate for both shapes (fast); the FULL gate is qa/harness/scale_run.js. */
const { test } = require('node:test'); const assert = require('node:assert/strict'); const path = require('path'); const { spawnSync } = require('child_process'); const REPO = path.resolve(__dirname, '..', '..');
for (const shape of ['master', 'txn']) test(`RT-34 scale gate: ${shape} shape, 2,000 rows completes without crash`, () => {
  const p = spawnSync(process.execPath, ['--experimental-sqlite', path.join(REPO, 'qa/harness/scale_run.js'), '--sizes=2000', `--shapes=${shape}`, '--label=gate', '--timeoutS=120'], { encoding: 'utf8' });
  assert.equal(p.status, 0, (p.stdout.split('\n').find(l => l.startsWith('{')) || p.stderr).slice(0, 300)); });
