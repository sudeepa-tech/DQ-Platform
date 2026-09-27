'use strict';
/* Runs a dataset through a REAL server process (isolated storage), measuring wall time, server peak RSS (/proc VmHWM)
   and the longest API stall (concurrent /health pings). Engine-agnostic: talks only to the public HTTP API. */
const { spawn } = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hwmMB = pid => { try { const m = /VmHWM:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8')); return m ? Math.round(m[1] / 1024) : null; } catch { return null; } };

async function withServer(fn, label = 'qa', nodeArgs = [], opts = {}) {   // opts.backendDir: run a different backend tree (e.g. the pristine original); opts.seedDb: start on a copy of an existing database
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `dq-qa-${label}-`)); const port = 4200 + Math.floor(Math.random() * 700);
  const env = { ...process.env, PORT: String(port), NODE_ENV: 'production', JWT_SECRET: 'qa-secret', SEED_ADMIN_EMAIL: 'qa@example.com', SEED_ADMIN_PASSWORD: 'QaPassw0rd!', CORS_ALLOWED_ORIGINS: 'http://127.0.0.1:' + port,
    DATA_DIR: path.join(tmp, 'data'), DB_PATH: path.join(tmp, 'data', 'qa.db'), UPLOAD_DIR: path.join(tmp, 'uploads'), EXPORT_DIR: path.join(tmp, 'exports') };
  const backendDir = opts.backendDir || path.join(REPO, 'backend');
  if (opts.seedDb) { fs.mkdirSync(path.dirname(env.DB_PATH), { recursive: true }); fs.copyFileSync(opts.seedDb, env.DB_PATH); }
  const child = spawn(process.execPath, ['--experimental-sqlite', ...nodeArgs, path.join(backendDir, 'src/server.js')], { env, cwd: backendDir, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => { log += d; if (log.length > 5e4) log = log.slice(-2e4); }); child.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await sleep(100); }
  try { return await fn({ base, pid: child.pid, dbPath: env.DB_PATH, tmp, log: () => log }); }
  finally { child.kill('SIGKILL'); }
}

async function api(ctx, method, url, body, form) {
  const r = await fetch(ctx.base + url, { signal: AbortSignal.timeout(ctx.fetchTimeoutMs || 900000), method, headers: { ...(ctx.token ? { Authorization: 'Bearer ' + ctx.token } : {}), ...(form ? {} : body ? { 'Content-Type': 'application/json' } : {}) }, body: form || (body ? JSON.stringify(body) : undefined) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j };
}

async function runDataset(ctx, { file, sheet, name = 'qa', pollMs = 200, timeoutMs = 600000 }) {
  ctx.token = (await api(ctx, 'POST', '/api/auth/login', { email: 'qa@example.com', password: 'QaPassw0rd!' })).body.token;
  const ds = (await api(ctx, 'POST', '/api/datasets', { name })).body.dataset;
  const fd = new FormData(); fd.append('file', new Blob([fs.readFileSync(file)]), path.basename(file));
  const up = await api(ctx, 'POST', `/api/datasets/${ds.id}/files`, null, fd);
  if (up.body.requires_sheet_selection) await api(ctx, 'POST', `/api/datasets/${ds.id}/files/${up.body.file_id}/select-sheet`, { sheet_name: sheet });
  let maxStall = 0, stop = false;
  (async () => { while (!stop) { const t = Date.now(); try { await fetch(ctx.base + '/health'); } catch {} maxStall = Math.max(maxStall, Date.now() - t); await sleep(100); } })();
  const t0 = Date.now(); const an = await api(ctx, 'POST', `/api/datasets/${ds.id}/analyze`);
  let run = { status: 'unknown' }, peak = 0;
  if (an.status === 202) {
    while (Date.now() - t0 < timeoutMs) { run = (await api(ctx, 'GET', `/api/runs/${an.body.run_id}`)).body.run || run; peak = Math.max(peak, hwmMB(ctx.pid) || 0); if (['complete', 'failed'].includes(run.status)) break; await sleep(pollMs); }
  }
  stop = true; const seconds = (Date.now() - t0) / 1000; peak = Math.max(peak, hwmMB(ctx.pid) || 0);
  return { datasetId: ds.id, runId: an.body.run_id, analyzeStatus: an.status, status: run.status, error: run.error_message || (an.status !== 202 ? JSON.stringify(an.body) : null), seconds, peakRssMB: peak, maxApiStallMs: maxStall, uploadStatus: up.status };
}
module.exports = { withServer, runDataset, api, hwmMB, REPO };

if (require.main === module) {
  const a = Object.fromEntries(process.argv.slice(2).map(s => s.replace(/^--/, '').split('=')));
  withServer(async ctx => { const r = await runDataset(ctx, { file: a.data, sheet: a.sheet, name: a.name || 'qa' }); console.log(JSON.stringify({ ...r, dbPath: ctx.dbPath })); }, 'cli').then(() => process.exit(0));
}
