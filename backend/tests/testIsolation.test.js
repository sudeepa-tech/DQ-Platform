'use strict';
// REGRESSION GUARD (S0 finding): a test must never be able to open the developer's real database, run stale-run recovery on it
// (which marks in-progress analysis runs as failed), or create real storage directories.
// This file itself never imports src/db: it only exercises config/paths and spawns child processes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolvePaths, inTestContext, TestIsolationError, PRODUCTION_DEFAULTS, BACKEND_ROOT } = require('../src/config/paths');

const REAL = { db: path.join(PRODUCTION_DEFAULTS.DATA_DIR, 'platform.db'), data: PRODUCTION_DEFAULTS.DATA_DIR, uploads: PRODUCTION_DEFAULTS.UPLOAD_DIR, exports: PRODUCTION_DEFAULTS.EXPORT_DIR };
const snapshot = () => Object.fromEntries(Object.entries(REAL).map(([k, p]) => { try { const s = fs.statSync(p); return [k, `${s.size}:${s.mtimeMs}`]; } catch { return [k, 'absent']; } }));
const cleanEnv = () => { const e = { ...process.env }; for (const k of ['DATA_DIR', 'DB_PATH', 'UPLOAD_DIR', 'EXPORT_DIR', 'NODE_ENV', 'NODE_TEST_CONTEXT']) delete e[k]; return e; };   // NODE_TEST_CONTEXT must go: a nested runner that inherits it behaves as a child and exits 0 even when its tests fail

test('outside a test context, paths are exactly the production defaults (behaviour unchanged for real use)', () => {
  const r = resolvePaths({ env: {}, argv: [] });
  assert.equal(r.testContext, false);
  assert.equal(r.DB_PATH, REAL.db);
  assert.equal(r.UPLOAD_DIR, REAL.uploads);
  assert.equal(r.EXPORT_DIR, REAL.exports);
  const custom = resolvePaths({ env: { DATA_DIR: '/srv/dq' }, argv: [] });
  assert.equal(custom.DB_PATH, path.join('/srv/dq', 'platform.db'));
});

test('test context is detected from NODE_TEST_CONTEXT, NODE_ENV=test and the --test flag', () => {
  assert.equal(inTestContext({ NODE_TEST_CONTEXT: 'child-v8' }, []), true);
  assert.equal(inTestContext({ NODE_ENV: 'test' }, []), true);
  assert.equal(inTestContext({}, ['--experimental-sqlite', '--test']), true);
  assert.equal(inTestContext({}, ['--test-reporter=tap']), true);
  assert.equal(inTestContext({ NODE_ENV: 'production' }, ['--experimental-sqlite']), false);
});

test('in a test context with nothing configured, every path is redirected to a private temp directory', () => {
  const r = resolvePaths({ env: { NODE_ENV: 'test' }, argv: [] });
  assert.equal(r.isolated, true);
  for (const p of [r.DATA_DIR, r.DB_PATH, r.UPLOAD_DIR, r.EXPORT_DIR]) {
    assert.ok(path.resolve(p).startsWith(path.resolve(os.tmpdir())), `${p} is not under the temp directory`);
    assert.ok(!path.resolve(p).startsWith(BACKEND_ROOT + path.sep), `${p} is inside the backend directory`);
  }
});

test('partially configured tests are completed safely: DATA_DIR/DB_PATH set, upload/export dirs redirected to temp', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-iso-'));
  const r = resolvePaths({ env: { NODE_ENV: 'test', DATA_DIR: path.join(tmp, 'data'), DB_PATH: path.join(tmp, 'data', 'x.db') }, argv: [] });
  assert.equal(r.DB_PATH, path.join(tmp, 'data', 'x.db'));
  assert.ok(r.UPLOAD_DIR.startsWith(os.tmpdir()) && r.EXPORT_DIR.startsWith(os.tmpdir()));
});

test('in a test context, pointing ANY storage path at the real application storage is refused', () => {
  const bad = { DATA_DIR: REAL.data, DB_PATH: REAL.db, UPLOAD_DIR: REAL.uploads, EXPORT_DIR: REAL.exports };
  for (const [name, value] of Object.entries(bad)) {
    assert.throws(() => resolvePaths({ env: { NODE_ENV: 'test', [name]: value }, argv: [] }), TestIsolationError, `${name} -> real storage must throw`);
  }
  assert.throws(() => resolvePaths({ env: { NODE_ENV: 'test', DB_PATH: path.join(REAL.data, 'nested', 'x.db') }, argv: [] }), TestIsolationError);
});

test('PROCESS-LEVEL: importing the db, upload and export modules under `node --test` with NO env vars never touches real storage', () => {
  const before = snapshot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-iso-child-'));
  const scratch = path.join(dir, 'scratch.test.js');
  const src = p => JSON.stringify(path.join(BACKEND_ROOT, 'src', p));
  fs.writeFileSync(scratch, `
    const test = require('node:test'); const assert = require('node:assert/strict'); const os = require('os'); const path = require('path');
    test('modules resolve to isolated storage', () => {
      const db = require(${src('db')});
      require(${src('engines/exportEngine')}); require(${src('middleware/upload')});
      const file = db.prepare('PRAGMA database_list').all().find(r => r.name === 'main').file;
      assert.ok(path.resolve(file).startsWith(path.resolve(os.tmpdir())), 'database opened at ' + file);
      assert.ok(!path.resolve(file).startsWith(${JSON.stringify(BACKEND_ROOT + path.sep)}), 'database opened inside backend/');
      assert.ok(require(${src('db')}).migration, 'migrations must have run on the isolated database');
    });`);   // (child success is verified by exit status AND the TAP line below)
  const p = spawnSync(process.execPath, ['--experimental-sqlite', '--test', scratch], { env: cleanEnv(), cwd: dir, encoding: 'utf8' });
  const after = snapshot();
  // if the guard ever regresses this test would itself have created real directories: clean up what WE created, then fail
  for (const k of Object.keys(REAL)) if (before[k] === 'absent' && after[k] !== 'absent') fs.rmSync(REAL[k], { recursive: true, force: true });
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.match(p.stdout, /^# pass 1$/m, 'the child test did not actually run and pass:\n' + p.stdout);
  assert.deepEqual(after, before, 'real storage changed while a test imported application modules');
});

test('PROCESS-LEVEL: a test that explicitly targets the real database is refused before anything is opened', () => {
  const before = snapshot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-iso-child-'));
  const scratch = path.join(dir, 'evil.test.js');
  fs.writeFileSync(scratch, `
    const test = require('node:test');
    process.env.DB_PATH = ${JSON.stringify(REAL.db)};
    test('must never get here', () => { require(${JSON.stringify(path.join(BACKEND_ROOT, 'src', 'db'))}); });`);
  const p = spawnSync(process.execPath, ['--experimental-sqlite', '--test', scratch], { env: cleanEnv(), cwd: dir, encoding: 'utf8' });
  const after = snapshot();
  for (const k of Object.keys(REAL)) if (before[k] === 'absent' && after[k] !== 'absent') fs.rmSync(REAL[k], { recursive: true, force: true });
  assert.notEqual(p.status, 0, 'the child test should have failed');
  assert.match(p.stdout + p.stderr, /TestIsolationError|Refusing to use/);
  assert.deepEqual(after, before, 'real storage changed');
});

test('no test file may reference the real database location or default storage directories', () => {
  const offenders = [];
  for (const f of fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js') && f !== path.basename(__filename))) {
    const text = fs.readFileSync(path.join(__dirname, f), 'utf8');
    if (/platform\.db|['"`]\.\.\/data|['"`]\.\.\/uploads|['"`]\.\.\/exports|backend\/data/.test(text)) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});

test('every test file that imports application modules is covered by isolation (sets storage env before import, or relies on the guard)', () => {
  // Belt and braces: the runtime guard makes every file safe, but each file should still say so explicitly.
  const needsExplicit = [];
  for (const f of fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js') && f !== path.basename(__filename))) {
    const text = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const importsDb = /require\((['"])\.\.\/src\/(?:server|db(?:\/index)?|engines\/(?:exportEngine|analysisOrchestrator)|routes\/[^'"]*)\1\)/.test(text);   // db/migrate.js has no side effects and is not matched
    if (importsDb && !/process\.env\.(DATA_DIR|DB_PATH)\s*=/.test(text)) needsExplicit.push(f);
  }
  assert.deepEqual(needsExplicit, [], 'these files import DB-opening modules without setting DATA_DIR/DB_PATH first');
});
