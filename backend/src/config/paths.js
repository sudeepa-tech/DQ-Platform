'use strict';
/*
 * Central storage-path resolution (S1). Replaces three independent `process.env.X || <default>` lookups.
 *
 * WHY THIS EXISTS: the database module opens its file (and runs stale-run recovery, which marks non-terminal runs 'failed')
 * at import time. A test that imported any module without first setting DATA_DIR therefore opened the developer's REAL
 * backend/data/platform.db and could mark real in-progress analysis runs as failed. (Found in S0: exportEngine.test.js.)
 *
 * RULE: in a test context this module NEVER resolves to the production data locations. Anything left unset is redirected
 * to a private temp directory; anything explicitly pointed at a production location throws TestIsolationError.
 * Outside a test context behaviour is exactly what it always was.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const PRODUCTION_DEFAULTS = Object.freeze({
  DATA_DIR: path.join(BACKEND_ROOT, 'data'),
  UPLOAD_DIR: path.join(BACKEND_ROOT, 'uploads'),
  EXPORT_DIR: path.join(BACKEND_ROOT, 'exports')
});

class TestIsolationError extends Error {
  constructor(message) { super(message); this.name = 'TestIsolationError'; }
}

// node:test sets NODE_TEST_CONTEXT in every runner subprocess; NODE_ENV=test and an explicit --test flag are also honoured.
function inTestContext(env = process.env, argv = process.execArgv) {
  return env.NODE_ENV === 'test' || !!env.NODE_TEST_CONTEXT || argv.some(a => a === '--test' || a.startsWith('--test-'));
}

const isInside = (child, parent) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

function resolvePaths({ env = process.env, argv = process.execArgv, tmpdir = os.tmpdir() } = {}) {
  const testContext = inTestContext(env, argv);
  if (!testContext) {
    const DATA_DIR = env.DATA_DIR || PRODUCTION_DEFAULTS.DATA_DIR;
    return { testContext, isolated: false, tempRoot: null, DATA_DIR, DB_PATH: env.DB_PATH || path.join(DATA_DIR, 'platform.db'),
      UPLOAD_DIR: env.UPLOAD_DIR || PRODUCTION_DEFAULTS.UPLOAD_DIR, EXPORT_DIR: env.EXPORT_DIR || PRODUCTION_DEFAULTS.EXPORT_DIR };
  }
  let tempRoot = null;
  const tmp = () => (tempRoot = tempRoot || fs.mkdtempSync(path.join(tmpdir, 'dq-platform-test-')));
  const DATA_DIR = env.DATA_DIR || path.join(tmp(), 'data');
  const resolved = { testContext, isolated: true, tempRoot, DATA_DIR, DB_PATH: env.DB_PATH || path.join(DATA_DIR, 'platform.db'),
    UPLOAD_DIR: env.UPLOAD_DIR || path.join(tmp(), 'uploads'), EXPORT_DIR: env.EXPORT_DIR || path.join(tmp(), 'exports') };
  resolved.tempRoot = tempRoot;
  for (const [name, p] of [['DATA_DIR', resolved.DATA_DIR], ['DB_PATH', resolved.DB_PATH], ['UPLOAD_DIR', resolved.UPLOAD_DIR], ['EXPORT_DIR', resolved.EXPORT_DIR]]) {
    for (const prod of Object.values(PRODUCTION_DEFAULTS)) {
      if (isInside(p, prod)) throw new TestIsolationError(`Refusing to use ${name}=${p} in a test context: it is inside the application's real storage (${prod}). Tests must use an isolated temp directory.`);
    }
  }
  return resolved;
}

module.exports = { ...resolvePaths(), resolvePaths, inTestContext, isInside, TestIsolationError, PRODUCTION_DEFAULTS, BACKEND_ROOT };
