'use strict';
/* Scale baseline / gate. node qa/harness/scale_run.js [--sizes=2000,5000,10000] [--shapes=master,txn] [--heapMB=2048] [--timeoutS=240] [--label=legacy]
   For each (shape,size): generate CSV, run through a fresh server (heap-capped), record: status/error, wall time, peak RSS, longest API stall,
   persisted pair count, and (master) precision/recall vs planted clusters. Exit code 1 if any run is not 'complete'. */
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const { withServer, runDataset, REPO } = require('./http_run'); const { loadRun } = require('./adapter_legacy_v0'); const { entityMetrics } = require('./score');
const a = Object.fromEntries(process.argv.slice(2).map(s => s.replace(/^--/, '').split('=')));
const sizes = (a.sizes || '2000,5000,10000').split(',').map(Number), shapes = (a.shapes || 'master,txn').split(','), heap = +(a.heapMB || 2048), tmo = +(a.timeoutS || 240) * 1000, label = a.label || 'legacy';
const work = path.join(REPO, 'qa/.work'); fs.mkdirSync(work, { recursive: true }); const results = [];
(async () => {
  for (const shape of shapes) for (const n of sizes) {
    const file = path.join(work, `${shape}_${n}.csv`); execFileSync(process.execPath, [path.join(__dirname, 'scale_gen.js'), `--shape=${shape}`, `--n=${n}`, `--out=${file}`], { stdio: 'ignore' });
    const res = await withServer(async ctx => {
      ctx.fetchTimeoutMs = tmo; const t = await Promise.race([runDataset(ctx, { file, name: `${shape}${n}` }), new Promise(r => setTimeout(() => r({ status: 'timeout', error: `no terminal state within ${tmo / 1000}s`, seconds: tmo / 1000, peakRssMB: null }), tmo + 5000))]);
      const oom = /heap|allocation failed|out of memory/i.test(ctx.log()); const o = { shape, n, ...t, server_oom_or_heap_error: oom || undefined };
      if (t.status === 'complete') { const view = loadRun(ctx.dbPath, { runId: t.runId, keyColumn: shape === 'master' ? 'Record_ID' : 'Invoice_No' }); o.persistedPairs = view.persistedPairs; o.entityClusters = view.entityClusters.length; o.itemClusters = view.itemClusters.length;
        if (shape === 'master') { const truth = JSON.parse(fs.readFileSync(file.replace(/\.csv$/, '.truth.json'))); const m = entityMetrics(view, truth); o.vs_planted = { truth_clusters: m.truth.clusters, app_clusters: m.app.clusters, record_precision: m.record.precision, record_recall: m.record.recall, pair_precision: m.pair.precision, pair_recall: m.pair.recall, clusters_with_two_valid_gstins: m.clusters_with_two_valid_gstins }; } }
      if (t.status === 'failed') o.server_log_error = ctx.log().split('\n').filter(l => /RangeError|Error:|failed/.test(l)).slice(-2); return o;
    }, `${shape}${n}`, [`--max-old-space-size=${heap}`]);
    results.push(res); console.log(JSON.stringify(res));
  }
  fs.mkdirSync(path.join(REPO, 'qa/baseline', label), { recursive: true }); fs.writeFileSync(path.join(REPO, 'qa/baseline', label, 'scale.json'), JSON.stringify({ heap_cap_mb: heap, timeout_s: tmo / 1000, results }, null, 1));
  process.exit(results.every(r => r.status === 'complete') ? 0 : 1);
})();
