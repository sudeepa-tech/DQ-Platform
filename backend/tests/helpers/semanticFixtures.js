'use strict';
/* Tiny in-memory canonical tables for semantic tests: mk([[header, (i) => value | {v, k}, key?], ...], nRows); key defaults to the header (give duplicates distinct keys, as ingest does). {v,k} carries a canonical cell kind (e.g. date_only). */
function mk(spec, n = 60) {
  const columns = spec.map(([h, , key], i) => ({ position: i, header_raw: h, header_key: key || h, header_normalized: h.toLowerCase().trim() }));
  const rows = [];
  for (let i = 0; i < n; i++) { const raw = {}, meta = {}; for (const [h, fn, key] of spec) { const kk = key || h; const c = fn(i); if (c === null || c === undefined) continue; if (c && c.k) { raw[kk] = c.v; meta[kk] = { k: c.k, st: c.st }; } else raw[kk] = c; } rows.push({ raw, meta }); }
  return { columns, rows };
}
const pad = (n, w) => String(n).padStart(w, '0');
const G = {
  digits10: i => String(1000000000 + i * 7),                    // 10-digit document-style numbers
  mobile: i => String(9800000000 + i * 13),                     // Indian mobile-style numbers
  user: i => 'USR' + pad(i % 4, 5),
  date: i => ({ v: `2024-01-${pad((i % 28) + 1, 2)}`, k: 'date_only' }),
  textDate: i => ({ v: `${pad((i % 27) + 1, 2)}.03.2024`, k: 'text_date', st: 'parsed' }),
  company: i => ['Orion Traders Pvt Ltd', 'Delta Works Ltd', 'Kalinga Steel Industries', 'Apex Supplies LLP'][i % 4] + ' ' + pad(i % 9, 2),
  freeText: i => `Hex bolt M${8 + (i % 5)} zinc plated, grade 8.8, box of ${10 * (1 + i % 4)} pieces`,
  email: i => `user${i}@vendor${i % 5}.example.com`,
  gstin: i => `27${['ABCDE', 'PQRST', 'LMNOP', 'UVWXY'][i % 4]}${pad(1000 + i, 4)}F1Z${'5A9B'[i % 4]}`,
  city: i => ['Pune', 'Mumbai', 'Chennai', 'Kolkata', 'Nagpur'][i % 5],
  state: i => ['Maharashtra', 'Tamil Nadu', 'West Bengal', 'Gujarat'][i % 4],
  address: i => `Plot ${10 + i}, Sector ${1 + i % 9}, Industrial Area, Phase ${1 + i % 3}`,
  pin: i => String(400001 + (i % 30) * 3),
  currency: i => ['INR', 'USD', 'EUR'][i % 3],
  uom: i => ['PCS', 'KG', 'LTR', 'BOX'][i % 4],
  qty: i => (i % 50) + 1, price: i => 100 + (i % 40) * 2.5, taxPct: i => [5, 12, 18, 28][i % 4],
  matId: i => 'M-' + pad(1000 + i, 5), vendorCode: i => 'V' + pad(100 + (i % 40), 4), docNo: i => String(4500000000 + i * 3), seq: i => i + 1
};
module.exports = { mk, G, pad };
