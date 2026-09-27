'use strict';
const H = require('../harness/inproc');
const GST = n => `27ABCDE${String(n).padStart(4, '0')}F1Z5`;                       // structurally valid GSTIN
const HEAD = ['ID', 'Entity_Type', 'Company_Name', 'GSTIN', 'Vendor_Code', 'Email', 'Phone', 'Address', 'City', 'State', 'Postal_Code', 'Creation_Date', 'Modification_Date'];
const A = ['Alpha', 'Bharat', 'Coastal', 'Dhruva', 'Everest', 'Falcon', 'Gemini', 'Harbor'], B = ['Textiles', 'Chemicals', 'Castings', 'Foods', 'Motors'];
/* a distinct, unrelated, fully-valid master-entity row; override any column by name */
function ent(i, over = {}) {
  const row = { ID: `ROW-${String(i).padStart(3, '0')}`, Entity_Type: 'Vendor', Company_Name: `${A[i % 8]} ${B[Math.floor(i / 8) % 5]} ${['Works', 'Traders', 'Industries', 'Corporation', 'Agencies', 'Associates'][Math.floor(i / 40) % 6]}`, GSTIN: GST(1000 + i), Vendor_Code: `V${5000 + i}`,
    Email: `accounts${i}@firm${i}.example.com`, Phone: `98${String(10000000 + i * 37).slice(-8)}`, Address: `${10 + i * 3} Sector ${i}, Industrial Area`, City: ['Pune', 'Nagpur', 'Indore', 'Surat', 'Raipur'][i % 5], State: 'MH', Postal_Code: String(400000 + i * 7), Creation_Date: '2024-03-15', Modification_Date: '2025-06-20', ...over };
  return HEAD.map(h => row[h]);
}
const fillers = (n, from = 100) => Array.from({ length: n }, (_, k) => ent(from + k));
async function boot() { const h = H.boot(); await H.login(h); return h; }
const clusterWith = (v, a, b) => v.entityClusters.find(c => c.members.includes(a) && (b === undefined || c.members.includes(b)));
const together = (v, a, b) => !!clusterWith(v, a, b);
module.exports = { H, GST, HEAD, ent, fillers, boot, together, clusterWith };
