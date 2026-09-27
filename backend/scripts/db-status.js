'use strict';
// Read-only report of the database's migration state. Usage: npm run db:status   (never modifies the database)
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const paths = require('../src/config/paths');
const { status } = require('../src/db/migrate');
if (!fs.existsSync(paths.DB_PATH)) { console.log(`No database yet at ${paths.DB_PATH} (it is created and migrated on first server start).`); process.exit(0); }
const raw = new DatabaseSync(paths.DB_PATH, { readOnly: true });
const s = status(raw);
console.log(`Database: ${paths.DB_PATH}\nState:    ${s.state}${s.problem ? '\nProblem:  ' + s.problem : ''}\nVersion:  ${s.current} of ${s.latest}`);
for (const a of s.applied) console.log(`  ${String(a.version).padStart(4, '0')} ${a.name.padEnd(28)} applied ${a.applied_at}${a.notes ? '  (' + a.notes + ')' : ''}`);
if (s.pending.length) console.log('Pending (applied automatically at next server start, after a verified backup):\n  ' + s.pending.join('\n  '));
raw.close();
process.exit(s.state === 'inconsistent' || s.state === 'newer_than_application' ? 1 : 0);
