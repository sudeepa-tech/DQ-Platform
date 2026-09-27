'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();

// Bootstrap a default organization + admin user on first run, using env vars if provided.
function ensureSeedUser() {
  const org = db.prepare('SELECT * FROM organizations LIMIT 1').get();
  let orgId = org?.id;
  if (!orgId) {
    orgId = uuid();
    db.prepare('INSERT INTO organizations (id, name) VALUES (?,?)').run(orgId, process.env.SEED_ORG_NAME || 'Default Organization');
  }
  const existing = db.prepare('SELECT * FROM users LIMIT 1').get();
  if (!existing) {
    // A well-known default admin password is a real production risk (silent, unauthenticated admin access). Refuse to
    // seed one in production unless an explicit password is supplied; local development / tests keep the convenience default.
    if (process.env.NODE_ENV === 'production' && !process.env.SEED_ADMIN_PASSWORD) {
      throw new Error('SEED_ADMIN_PASSWORD must be set in production (no default admin password is used).');
    }
    const email = process.env.SEED_ADMIN_EMAIL || 'admin@example.com';
    const password = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO users (id, organization_id, name, email, password_hash, role) VALUES (?,?,?,?,?,?)')
      .run(uuid(), orgId, 'Administrator', email, hash, 'admin');
    // Never echo the password to logs -- even the well-known local default is better not modeled as "credentials get
    // printed here", since operators may copy this pattern for a real SEED_ADMIN_PASSWORD without noticing the risk.
    console.log(`\n[seed] Created default admin user -> email: ${email}`);
    console.log(process.env.SEED_ADMIN_PASSWORD ? '[seed] Password is the one provided via SEED_ADMIN_PASSWORD.\n' : "[seed] Password is the documented local-development default (see SEED_ADMIN_PASSWORD in the README) -- set SEED_ADMIN_PASSWORD to change it.\n");
  }
}
ensureSeedUser();

// Brute-force protection: a fixed, generous-but-real limit per (IP, attempted email) so a legitimate user retyping a
// password isn't locked out by someone else's traffic, while a credential-stuffing attempt against one account is capped.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyFn: req => req.ip + '|' + String((req.body || {}).email || '').toLowerCase() });
router.post('/login', loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase().trim());
  if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });
  const token = signToken(user);
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
