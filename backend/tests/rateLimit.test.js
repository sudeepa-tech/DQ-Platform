'use strict';
/* S8 security: rate limiting on login (brute-force) and upload/analyze (abuse/DoS). */
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { rateLimit, _resetForTests } = require('../src/middleware/rateLimit');

function fakeReqRes(ip) { const req = { ip, headers: {} }; let status = 200, body = null, headers = {}; const res = { setHeader: (k, v) => { headers[k] = v; }, status: (s) => { status = s; return res; }, json: (b) => { body = b; } }; return { req, res, get status() { return status; }, get body() { return body; }, get headers() { return headers; } }; }

test('allows up to max requests in the window, then refuses with 429 and Retry-After', () => {
  _resetForTests(); const mw = rateLimit({ windowMs: 10000, max: 3, keyFn: r => r.ip });
  for (let i = 0; i < 3; i++) { const w = fakeReqRes('1.2.3.4'); let called = false; mw(w.req, w.res, () => { called = true; }); assert.equal(called, true, `request ${i + 1} should pass`); }
  const w = fakeReqRes('1.2.3.4'); let called = false; mw(w.req, w.res, () => { called = true; });
  assert.equal(called, false); assert.equal(w.status, 429); assert.ok(w.headers['Retry-After'] > 0);
});
test('different keys (different IPs / users) are limited independently', () => {
  _resetForTests(); const mw = rateLimit({ windowMs: 10000, max: 1, keyFn: r => r.ip });
  const a = fakeReqRes('1.1.1.1'); let aOk = false; mw(a.req, a.res, () => { aOk = true; }); assert.equal(aOk, true);
  const b = fakeReqRes('2.2.2.2'); let bOk = false; mw(b.req, b.res, () => { bOk = true; }); assert.equal(bOk, true, 'a different key is not affected by another key\'s usage');
});
test('resets after the window elapses', async () => {
  _resetForTests(); const mw = rateLimit({ windowMs: 30, max: 1, keyFn: r => r.ip });
  const a = fakeReqRes('9.9.9.9'); let aOk = false; mw(a.req, a.res, () => { aOk = true; }); assert.equal(aOk, true);
  const b = fakeReqRes('9.9.9.9'); let bOk = false; mw(b.req, b.res, () => { bOk = true; }); assert.equal(bOk, false, 'still within the window');
  await new Promise(r => setTimeout(r, 40));
  const c = fakeReqRes('9.9.9.9'); let cOk = false; mw(c.req, c.res, () => { cOk = true; }); assert.equal(cOk, true, 'the window has reset');
});
