'use strict';
/* Deterministic synthetic LOAD datasets (NOT quality truth for real data). Two shapes:
   master  : ERP_Dump-like adversarial master entity file (numeric-suffix names, shared cities/street patterns, 12 item codes)
             with 5% planted duplicates (40% exact, 30% upper-case, 30% root-typo; same hard IDs) and truth clusters.
   txn     : transaction file (unique Invoice_No, ~100 repeated vendors, 12 item codes); truth: no entity duplicates;
             1% rows repeated verbatim with the same Invoice_No (transaction duplicates, informational).
   node scale_gen.js --shape=master --n=5000 --out=qa/.work/master_5000.csv                                             */
const fs = require('fs'); const path = require('path');
const a = Object.fromEntries(process.argv.slice(2).map(s => s.replace(/^--/, '').split('='))); const n = +a.n, shape = a.shape;
let seed = 123456789; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296; const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const ROOTS = ['Apex Industrial Supplies', 'Eastern Components', 'Shree Logistics', 'Vertex Engineering', 'Orion Manufacturing', 'BluePeak Traders', 'Prime Electricals', 'Sunrise Packaging', 'Metro Industrial Works', 'Delta Auto Components', 'Nova Systems', 'Evergreen Distributors', 'Pioneer Metals', 'Global Machinery', 'Sterling Enterprises', 'Crown Plastics', 'Acme Processors', 'NorthStar Technologies', 'Zenith Equipment', 'Kalinga Industrial Solutions'];
const CITIES = ['Mumbai', 'Cuttack', 'Bengaluru', 'Bhubaneswar', 'Pune', 'Kolkata', 'Chennai', 'Hyderabad'];
const ITEMS = [['MAT-1001', 'Industrial Bearing 6205', 'PCS', 1850], ['MAT-1002', 'Stainless Steel Bolt M10', 'PCS', 18.5], ['MAT-1003', 'Copper Cable 2.5 SQMM', 'MTR', 72], ['MAT-1004', 'Hydraulic Hose 1/2 Inch', 'MTR', 640], ['MAT-1005', 'Industrial Safety Helmet', 'PCS', 420], ['MAT-1006', 'PVC Insulation Tape 20M', 'ROLL', 38], ['MAT-1007', 'Electric Motor 5HP', 'PCS', 18500], ['MAT-1008', 'Gear Oil EP 90', 'LTR', 210], ['MAT-1009', 'Packaging Carton 12x10x8', 'PCS', 42], ['MAT-1010', 'Welding Electrode 3.15MM', 'BOX', 390], ['MAT-1011', 'Mild Steel Plate 6MM', 'KG', 78], ['MAT-1012', 'Industrial Lubricant ISO 68', 'LTR', 245]];
const b26 = (x, k) => { let s = ''; for (let i = 0; i < k; i++) { s = String.fromCharCode(65 + x % 26) + s; x = Math.floor(x / 26); } return s; };
const date = () => `${ri(2022, 2026)}-${String(ri(1, 12)).padStart(2, '0')}-${String(ri(1, 28)).padStart(2, '0')}`;
const csv = (h, rows) => h.join(',') + '\n' + rows.map(r => r.map(v => { v = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',')).join('\n') + '\n';
const truth = { entity_clusters: [], ambiguous_pairs: [], fuzzy_candidates: [], conflict_groups: [], item_conflicts: [], meta: { mapping: { columns: { gstin: 'GSTIN', row_id: 'Record_ID' } } }, records: {}, missing: { records: {} }, invalid: { records: {} }, temporal: { modified_before_created: [], future_created: [], future_modified: [] }, stale_table: [] };
let head, rows = [];
if (shape === 'master') {
  head = ['Record_ID', 'Entity_Type', 'Company_Name', 'GSTIN', 'Vendor_Code', 'Item_Code', 'Item_Description', 'UOM', 'Quantity', 'Unit_Price', 'Tax_Rate', 'Email', 'Phone', 'Address', 'City', 'State', 'Postal_Code', 'Creation_Date', 'Modification_Date'];
  const nb = Math.round(n / 1.05); const base = [];
  for (let i = 0; i < nb; i++) { const it = ITEMS[i % 12], city = CITIES[i % 8], c = ri(2022, 2025); const cd = `${c}-${String(ri(1, 12)).padStart(2, '0')}-10`, md = `${c + 1}-${String(ri(1, 12)).padStart(2, '0')}-10`;
    base.push([`S-${String(i + 1).padStart(6, '0')}`, i % 2 ? 'Vendor' : 'Customer', `${ROOTS[i % 20]} ${i + 1}`, `${10 + (i % 27)}${b26(i, 5)}${String(i % 10000).padStart(4, '0')}F1Z${b26(i, 1)}`, `V${100000 + i}`, it[0], it[1], it[2], ri(1, 500), it[3], [5, 12, 18][i % 3], `contact${i + 1}@vendor${i + 1}.com`, `9${String(10000000 + i).padStart(9, '0').slice(-9)}`, `${i + 10} Industrial Estate, ${city}`, city, 'State', `${110000 + (i % 900)}`, cd, md]); }
  rows = base.slice(); let next = nb;
  for (let k = 0; k < n - nb; k++) { const b = base[ri(0, nb - 1)].slice(); const kind = rnd(); b[0] = `S-${String(++next).padStart(6, '0')}`;
    if (kind < 0.4) { } else if (kind < 0.7) b[2] = b[2].toUpperCase(); else { const s = b[2], j = ri(2, Math.max(3, s.length - 8)); b[2] = s.slice(0, j) + s[j + 1] + s[j] + s.slice(j + 2); }
    rows.push(b); const orig = base.find(x => x[4] === b[4]); truth.entity_clusters.push({ members: [orig[0], b[0]].sort() }); }
  // merge clusters that share a base (a base can have >1 copy)
  const par = {}; const f = x => (par[x] === undefined ? x : (par[x] = f(par[x]))); truth.entity_clusters.forEach(c => { par[f(c.members[0])] = f(c.members[1]); }); const g = {}; truth.entity_clusters.forEach(c => c.members.forEach(m => { (g[f(m)] = g[f(m)] || new Set()).add(m); })); truth.entity_clusters = Object.values(g).map(s => ({ members: [...s].sort() }));
} else {
  head = ['Invoice_No', 'PO_Reference', 'Vendor_Code', 'Vendor_Name', 'Item_Code', 'Item_Description', 'Quantity', 'Unit_Price', 'Amount', 'Posting_Date', 'Created_On', 'Changed_On', 'Currency'];
  for (let i = 0; i < n; i++) { const it = ITEMS[ri(0, 11)], v = ri(1, 100), qty = ri(1, 100); rows.push([`INV-${String(i + 1).padStart(7, '0')}`, `PO-${String(ri(1, 5000)).padStart(6, '0')}`, `V${1000 + v}`, `${ROOTS[v % 20]} ${v}`, it[0], it[1], qty, it[3], qty * it[3], date(), date(), date(), 'INR']); }
  const dups = Math.round(n * 0.01); for (let k = 0; k < dups; k++) rows.push(rows[ri(0, n - 1)].slice());
}
fs.mkdirSync(path.dirname(a.out), { recursive: true }); fs.writeFileSync(a.out, csv(head, rows));
if (shape === 'master') fs.writeFileSync(a.out.replace(/\.csv$/, '.truth.json'), JSON.stringify(truth));
console.log(`${shape} n=${rows.length} -> ${a.out}` + (shape === 'master' ? ` (planted clusters: ${truth.entity_clusters.length})` : ''));
