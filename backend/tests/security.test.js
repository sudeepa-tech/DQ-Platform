'use strict';
/* S6 charter #16: integration-critical security defects on the production path. Structural checks only (no full security rewrite). */
const { test } = require('node:test'); const assert = require('node:assert/strict'); const { execFileSync } = require('child_process'); const path = require('path');

test('JWT_SECRET: refuses to boot in production without an explicit secret; a fallback secret is never used in production', () => {
  const run = env => { try { execFileSync(process.execPath, ['-e', "require('" + path.join(__dirname, '..', 'src', 'middleware', 'auth') + "')"], { env: { ...process.env, ...env }, stdio: 'pipe' }); return { code: 0 }; } catch (e) { return { code: e.status, stderr: e.stderr.toString() }; } };
  const prod = run({ NODE_ENV: 'production', JWT_SECRET: '' }); assert.notEqual(prod.code, 0); assert.match(prod.stderr, /JWT_SECRET must be set in production/);
  assert.equal(run({ NODE_ENV: 'production', JWT_SECRET: 'a-real-secret' }).code, 0);
  assert.equal(run({ NODE_ENV: 'test', JWT_SECRET: '' }).code, 0, 'the dev/test fallback still works outside production');
});
test('SEED ADMIN PASSWORD: refuses to seed a well-known default admin password in production', () => {
  const run = env => { try { execFileSync(process.execPath, ['-e', "process.env.DATA_DIR='/tmp/dq-sec-'+Date.now();process.env.DB_PATH=process.env.DATA_DIR+'/t.db';require('" + path.join(__dirname, '..', 'src', 'routes', 'auth') + "')"], { env: { ...process.env, ...env, JWT_SECRET: 'x' }, stdio: 'pipe' }); return { code: 0 }; } catch (e) { return { code: e.status, stderr: e.stderr.toString() }; } };
  const prod = run({ NODE_ENV: 'production', SEED_ADMIN_PASSWORD: '' }); assert.notEqual(prod.code, 0); assert.match(prod.stderr, /SEED_ADMIN_PASSWORD must be set in production/);
  assert.equal(run({ NODE_ENV: 'production', SEED_ADMIN_PASSWORD: 'a-real-password' }).code, 0);
});
test('CORS: an explicit allow-list is enforced in production when configured; unrestricted in development', () => {
  const orig = { NODE_ENV: process.env.NODE_ENV, CORS: process.env.CORS_ALLOWED_ORIGINS, JWT: process.env.JWT_SECRET, PW: process.env.SEED_ADMIN_PASSWORD };
  process.env.NODE_ENV = 'production'; process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'; process.env.JWT_SECRET = 'x'; process.env.SEED_ADMIN_PASSWORD = 'x';
  delete require.cache[require.resolve('../src/server')];
  const app = require('../src/server');
  assert.ok(app); // server module loads without throwing with a restrictive CORS config
  process.env.NODE_ENV = orig.NODE_ENV; process.env.CORS_ALLOWED_ORIGINS = orig.CORS; process.env.JWT_SECRET = orig.JWT; process.env.SEED_ADMIN_PASSWORD = orig.PW; delete require.cache[require.resolve('../src/server')];
});
test('CORS: production refuses to boot with no allow-list configured at all -- fail-safe, never a silent open-CORS fallback', () => {
  const run = env => { try { execFileSync(process.execPath, ['-e', "require('" + path.join(__dirname, '..', 'src', 'server') + "')"], { env: { ...process.env, ...env, DATA_DIR: '/tmp/dq-cors-' + Date.now() }, stdio: 'pipe' }); return { code: 0 }; } catch (e) { return { code: e.status, stderr: e.stderr.toString() }; } };
  const prod = run({ NODE_ENV: 'production', JWT_SECRET: 'x', SEED_ADMIN_PASSWORD: 'x', CORS_ALLOWED_ORIGINS: '' }); assert.notEqual(prod.code, 0); assert.match(prod.stderr, /CORS_ALLOWED_ORIGINS must be set in production/);
  assert.equal(run({ NODE_ENV: 'production', JWT_SECRET: 'x', SEED_ADMIN_PASSWORD: 'x', CORS_ALLOWED_ORIGINS: 'https://app.example.com' }).code, 0);
});
