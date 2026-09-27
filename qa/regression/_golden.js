'use strict';
/* Golden suite: engine output vs the INDEPENDENT oracle's truth. Acceptance bars are pre-registered in qa/README.md (not derived from any run).
   Nothing here names an expected count; every expectation is computed from the truth file.                                              */
const { describe, it, before } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path');
const { H, boot } = require('./_lib'); const { scoreAll } = require('../harness/score'); const REPO = path.resolve(__dirname, '..', '..');
const BAR = { precision: 0.98, recall: 0.98, minorityPrecision: 0.9, consistencySensitivity: 0.5 };
module.exports = function golden(label, file, sheet, truthFile) {
  describe(`GOLD ${label}`, () => {
    let S, V, T, D; const tag = s => `GOLD:${label}: ${s}`;
    before(async () => { T = JSON.parse(fs.readFileSync(path.join(REPO, 'qa/oracle/truth', truthFile))); const h = await boot(); const r = await H.runFile(h, path.join(REPO, file), { sheet });
      assert.equal(r.status, 'complete', 'analysis did not complete: ' + r.error); V = H.view(h, r.runId, T.meta.mapping.columns.row_id); D = await H.dashboard(h, r.runId); S = scoreAll(V, T, { referenceDate: new Date().toISOString().slice(0, 10) }); });
    it(tag('entity clusters: record-level precision & recall >= bar'), () => { const r = S.entity.record; assert.ok(r.precision >= BAR.precision && r.recall >= BAR.recall, `precision=${r.precision} recall=${r.recall} (tp=${r.tp} fp=${r.fp} fn=${r.fn}) fp_ids=${r.fp_ids} fn_ids=${r.fn_ids}`); });
    it(tag('entity clusters: pair-level precision & recall >= bar'), () => { const r = S.entity.pair; assert.ok(r.precision >= BAR.precision && r.recall >= BAR.recall, `pair precision=${r.precision} recall=${r.recall}`); });
    it(tag('no cluster contains two different valid GSTINs (hard invariant)'), () => assert.equal(S.entity.clusters_with_two_valid_gstins, 0));
    it(tag('fuzzy candidates are never auto-clustered'), () => assert.equal(S.entity.fuzzy_candidates_auto_clustered, 0));
    it(tag('every oracle conflict type is detected and each group is reported exactly once'), () => { const c = S.conflicts, miss = Object.entries(c).filter(([k, v]) => k.startsWith('found_') && v.split('/')[0] !== v.split('/')[1]).map(([k, v]) => `${k}=${v}`);
      assert.deepEqual(miss, [], 'undetected conflict types'); assert.equal(c.rows_per_distinct_group, 1, `conflict inflation ${c.rows_per_distinct_group}x (${c.app_conflict_rows_identity_or_contact} rows for ${c.app_distinct_member_sets} groups)`); assert.equal(c.extra_groups_not_in_truth, 0); });
    it(tag('item-code conflicts: all codes found, none spurious, minority records identified'), () => { const i = S.item; assert.equal(i.codes_found, i.truth_codes, `missing ${i.codes_missing}`); assert.deepEqual(i.codes_extra, []); assert.equal(i.minority_recall, 1);
      assert.ok(i.flagged_precision_vs_minority >= BAR.minorityPrecision, `flags ${i.records_flagged_by_conflicts} records to expose ${i.minority_truth_records} minority records (precision ${i.flagged_precision_vs_minority})`); });
    it(tag('missing data: exact record set and fields'), () => { const m = S.issues.missing; assert.deepEqual([m.fn, m.fp], [0, 0], `fn=${m.fn} fp=${m.fp} fn_ids=${m.fn_ids} fp_ids=${m.fp_ids}`); });
    it(tag('invalid data: exact record set (format & range rules)'), () => { const m = S.issues.invalid; assert.deepEqual([m.fn, m.fp], [0, 0], `fn=${m.fn} fp=${m.fp} by field: ${JSON.stringify(S.issues.invalid.by_field_detected)}`); });
    it(tag('temporal anomalies (modified<created) and future dates: exact'), () => { const t = S.issues.temporal, f = S.issues.future; assert.deepEqual([t.fn, t.fp, f.fn, f.fp], [0, 0, 0, 0], `temporal ${t.tp}/${t.expected} future ${f.tp}/${f.expected}`); });
    it(tag('stale records are consistent with the engine\'s own configured threshold and reference date'), () => { const s = S.issues.stale; assert.deepEqual([s.fn, s.fp], [0, 0], `threshold=${s.threshold_years}y ref=${s.reference_date}: expected ${s.expected} detected ${s.detected}`); });
    it(tag('repeated item/material codes never raise duplicate-identifier issues'), () => assert.equal(S.issues.uniqueness_noise.on_item_or_material_fields, 0));
    it(tag('consistency score reflects conflicts (sensitivity floor)'), () => { const rec = new Set([...T.conflict_groups.flatMap(g => g.members), ...T.temporal.modified_before_created, ...T.item_conflicts.flatMap(g => g.minority_records)]); const share = rec.size / Object.keys(T.records).length, cap = 100 * (1 - BAR.consistencySensitivity * share);
      assert.ok(S.scores.dims.consistency <= cap, `consistency=${S.scores.dims.consistency} but ${(100 * share).toFixed(1)}% of records are in conflicts (must be <= ${cap.toFixed(1)})`); });
  });
};
