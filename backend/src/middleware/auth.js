'use strict';
const jwt = require('jsonwebtoken');
const db = require('../db');

// A fallback secret is a real production risk (any token forged with the well-known default is accepted). Refuse to boot in
// production without an explicit JWT_SECRET; keep the convenience default for local development / tests only.
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production (no fallback secret is used).');
}
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

function signToken(user) {
  return jwt.sign(
    { sub: user.id, org: user.organization_id, role: user.role, name: user.name, email: user.email },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // A token's SIGNATURE can still be valid while the user/organization it
    // references no longer exists in the current database -- this happens
    // whenever the database is reset or replaced (a fresh install, a wiped
    // dev database, restoring an older backup) while a browser tab still
    // holds a token issued against the previous database. Left unchecked,
    // such a request sails through auth and then fails downstream as a
    // confusing raw SQL foreign-key error. Checking here turns that into a
    // clear, actionable message instead.
    const stillExists = db.prepare('SELECT 1 FROM users WHERE id = ? AND organization_id = ?').get(payload.sub, payload.org);
    if (!stillExists) {
      return res.status(401).json({ error: 'Your session no longer matches the current database (it may have been reset). Please sign out and log in again.' });
    }
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' });
  next();
}

module.exports = { signToken, requireAuth, requireAdmin, JWT_SECRET };
