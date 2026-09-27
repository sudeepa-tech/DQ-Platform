'use strict';
/*
 * Minimal, dependency-free sliding-window-ish rate limiter (fixed window, reset on expiry). No new package: a security
 * control this small is more auditable hand-written than pulled in as a dependency. In-memory, per-process -- adequate
 * for a single-node deployment; a multi-node deployment would need a shared store (Redis), noted as a deployment
 * prerequisite rather than implemented here (no such infrastructure exists in this environment to wire up safely).
 */
const buckets = new Map();   // key -> { count, resetAt }
let lastSweep = Date.now();

function rateLimit({ windowMs, max, keyFn }) {
  return (req, res, next) => {
    if (process.env.RATE_LIMIT_DISABLED) return next();   // tests that legitimately fire many rapid requests opt out explicitly; production never sets this
    const now = Date.now();
    if (now - lastSweep > windowMs * 4) { for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k); lastSweep = now; }   // occasional cleanup, bounded cost
    const key = (keyFn ? keyFn(req) : req.ip) || 'unknown';
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + windowMs }; buckets.set(key, b); }
    b.count++;
    if (b.count > max) {
      res.setHeader('Retry-After', Math.ceil((b.resetAt - now) / 1000));
      return res.status(429).json({ error: 'Too many requests. Please slow down and try again shortly.' });
    }
    next();
  };
}
/** Test-only: clear all buckets so tests don't leak state across cases. */
function _resetForTests() { buckets.clear(); }
module.exports = { rateLimit, _resetForTests };
