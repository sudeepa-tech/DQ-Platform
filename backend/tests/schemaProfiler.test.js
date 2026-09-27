'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { profileSheet } = require('../legacy_v0/engines/schemaProfiler');

test('profileSheet infers email, gstin, phone, and date roles from content when headers are ambiguous', () => {
  const headers = ['Contact', 'Tax ID', 'Mobile', 'Since'];
  const rows = [
    { Contact: 'a@example.com', 'Tax ID': '27AAAAA0000A1Z5', Mobile: '9876543210', Since: '2020-01-01' },
    { Contact: 'b@example.com', 'Tax ID': '29BBBBB1111B2Z6', Mobile: '8765432109', Since: '2021-05-05' },
    { Contact: 'c@example.com', 'Tax ID': '24CCCCC2222C3Z7', Mobile: '7654321098', Since: '2019-07-20' }
  ];
  const profiles = profileSheet(rows, headers);
  const byName = Object.fromEntries(profiles.map(p => [p.column_name, p]));
  assert.equal(byName['Contact'].inferred_role, 'email');
  assert.equal(byName['Tax ID'].inferred_role, 'gstin');
  assert.equal(byName['Since'].inferred_type, 'date');
});

test('profileSheet infers role from header hints (Vendor Name -> name)', () => {
  const headers = ['Vendor Name', 'GSTIN'];
  const rows = [{ 'Vendor Name': 'ABC Industries', GSTIN: '27AAAAA0000A1Z5' }];
  const profiles = profileSheet(rows, headers);
  const byName = Object.fromEntries(profiles.map(p => [p.column_name, p]));
  assert.equal(byName['Vendor Name'].inferred_role, 'name');
  assert.equal(byName['GSTIN'].inferred_role, 'gstin');
});

test('profileSheet reports null percentage and distinct count correctly', () => {
  const headers = ['Code'];
  const rows = [{ Code: 'A' }, { Code: 'A' }, { Code: null }, { Code: 'B' }];
  const profiles = profileSheet(rows, headers);
  const p = profiles[0];
  assert.equal(p.null_count, 1);
  assert.equal(p.null_pct, 0.25);
  assert.equal(p.distinct_count, 2); // 'A' and 'B'
});

test('profileSheet assigns created_date / modified_date to two unlabeled date columns in order', () => {
  const headers = ['Name', 'DateA', 'DateB'];
  const rows = [
    { Name: 'X', DateA: '2019-01-01', DateB: '2021-01-01' },
    { Name: 'Y', DateA: '2018-06-01', DateB: '2020-06-01' }
  ];
  const profiles = profileSheet(rows, headers);
  const byName = Object.fromEntries(profiles.map(p => [p.column_name, p]));
  assert.equal(byName['DateA'].inferred_role, 'created_date');
  assert.equal(byName['DateB'].inferred_role, 'modified_date');
});
