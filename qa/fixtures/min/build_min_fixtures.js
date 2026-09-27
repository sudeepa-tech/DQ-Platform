'use strict';
/* One-off builder (kept for reproducibility). Extracts, from the ERP_Dump fixture, 5 rows taken from ONE legacy false-positive cluster,
   keeping ONE record per distinct true entity (per the independent oracle) -> a minimal REAL-data repro (R07): 5 pairwise different entities.
   Run:  node --experimental-sqlite qa/fixtures/min/build_min_fixtures.js   (uses the legacy engine as-is)                              */
const fs = require('fs'); const path = require('path'); const H = require('../../harness/inproc');
const truth = JSON.parse(fs.readFileSync(path.join(__dirname, '../../oracle/truth/erp_dump.truth.json')));
(async () => {
  const h = H.boot(); await H.login(h);
  const r = await H.runFile(h, path.join(__dirname, '../ERP_DQ_Authenticity_Test_Dump.xlsx'), { sheet: 'ERP_Dump' }); const v = H.view(h, r.runId, 'Record_ID');
  const tOf = new Map(); truth.entity_clusters.forEach((c, i) => c.members.forEach(m => tOf.set(m, i)));
  let ids = null, from = 0;
  for (const c of v.entityClusters.slice().sort((a, b) => a.members.length - b.members.length)) {
    const seen = new Set(), pick = [];
    for (const m of c.members) { const o = tOf.has(m) ? 't' + tOf.get(m) : 'x' + m; if (!seen.has(o)) { seen.add(o); pick.push(m); } }
    if (pick.length >= 5) { ids = pick.slice(0, 5); from = c.members.length; break; }
  }
  if (!ids) throw new Error('no suitable legacy false cluster found');
  const cols = Object.keys(v.records.get(ids[0]));
  fs.writeFileSync(path.join(__dirname, 'fp_cluster_5_distinct_entities.csv'), H.csv(cols, ids.map(id => cols.map(c => v.records.get(id)[c]))));
  console.log('legacy cluster of', from, 'records -> wrote 5 pairwise-different entities:', ids.join(', ')); process.exit(0);
})();
