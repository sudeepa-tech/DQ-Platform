'use strict';
/*
 * RULE CATALOG (S4). Every data-quality rule the engine can run, with its category, scope, default severity and default parameters.
 * Rules never look at header text: they run because the CONFIRMED semantic mapping says a column has a role, a requiredness and a validation profile.
 * `type` is the issue-type slug carried on findings (kept identical to the vocabulary the platform already exposes).
 */
const RULE_ENGINE_VERSION = 'rules-1.0.0';
const RULE_CATALOG_VERSION = 'rule-catalog-1.0.0';
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const CATEGORIES = ['completeness', 'validity', 'consistency', 'freshness', 'uniqueness'];
const R = (category, type, scope, severity, params = {}, enabled = true, summary = '') => ({ category, type, scope, default_severity: severity, default_params: params, default_enabled: enabled, summary });
const PLACEHOLDERS = ['n/a', 'na', 'n.a.', 'nil', 'null', 'none', 'tbd', 'tba', '-', '--', '.', '?', 'xxx', 'unknown', 'test', 'dummy', 'not available'];
const RULES = {
  // completeness (driven by REQUIREDNESS: optional gaps are never defects)
  'completeness.required_missing': R('completeness', 'missing_required', 'record', 'high', {}, true, 'A REQUIRED column has no value on this record.'),
  'completeness.expected_missing': R('completeness', 'missing_expected', 'record', 'low', {}, true, 'An EXPECTED column has no value on this record.'),
  'completeness.column_empty': R('completeness', 'column_empty', 'dataset', 'high', {}, true, 'A REQUIRED / EXPECTED column is empty on every record: one dataset-level finding, not one per row.'),
  // validity (attached through the mapping's validation profile, by ROLE)
  'validity.email_format': R('validity', 'invalid_email', 'record', 'medium', {}, true, 'Value is not shaped like an e-mail address.'),
  'validity.phone_format': R('validity', 'invalid_phone', 'record', 'medium', { regions: ['IN'], allow_international: true }, true, 'Value is not a valid phone number for the configured regions.'),
  'validity.legal_id_format': R('validity', 'invalid_legal_id', 'record', 'high', { schemes: ['gstin', 'pan'] }, true, 'Value does not match any configured legal-id structure (GSTIN / PAN).'),
  'validity.legal_id_gstin_checksum': R('validity', 'invalid_gstin_checksum', 'record', 'medium', {}, false, 'OPT-IN pack: GSTIN check character does not match.'),
  'validity.legal_id_gstin_state_code': R('validity', 'invalid_gstin_state', 'record', 'medium', {}, false, 'OPT-IN pack: GSTIN state code is not a valid state / UT code.'),
  'validity.postal_code_format': R('validity', 'invalid_postal_code', 'record', 'medium', { patterns: ['^[1-9][0-9]{5}$'] }, true, 'Value does not match a configured postal-code pattern.'),
  'validity.numeric': R('validity', 'invalid_number', 'record', 'high', {}, true, 'Value is not a number.'),
  'validity.numeric_non_negative': R('validity', 'invalid_number', 'record', 'high', { min: 0 }, true, 'Value is not a number, or is below the minimum (default 0).'),
  'validity.percentage_range': R('validity', 'out_of_range', 'record', 'high', { min: 0, max: 100 }, true, 'Value is not a number within the percentage range.'),
  'validity.currency_code': R('validity', 'invalid_currency', 'record', 'medium', { mode: 'shape' }, true, 'Value is not a currency code (shape: three upper-case letters; mode "iso_common" also checks a common ISO 4217 list).'),
  'validity.uom_known': R('validity', 'invalid_uom', 'record', 'low', { mode: 'shape' }, true, 'Value is not a plausible unit-of-measure code (mode "known" checks a code list).'),
  'validity.identifier_format': R('validity', 'invalid_identifier', 'record', 'medium', { max_length: 64, placeholders: PLACEHOLDERS }, true, 'Identifier is padded with spaces, contains control characters, is a placeholder, or is too long.'),
  'validity.text_not_placeholder': R('validity', 'placeholder_value', 'record', 'low', { placeholders: PLACEHOLDERS }, true, 'The whole value is a placeholder (N/A, TBD, ...), not real content.'),
  'validity.date_calendar': R('validity', 'invalid_date', 'record', 'high', {}, true, 'Value is not a real calendar date (impossible day/month, or not a date at all).'),
  'validity.time_of_day': R('validity', 'invalid_time', 'record', 'medium', {}, true, 'Value is not a time of day.'),
  'validity.date_format_unresolved': R('validity', 'date_format_unresolved', 'dataset', 'low', {}, true, 'Text dates whose format is ambiguous were NOT guessed: a date-format decision is needed.'),
  'validity.systematic_failure': R('validity', 'systematic_failure', 'dataset', 'medium', {}, true, 'A rule fails on (almost) every value of a column: that points to a wrong mapping or format, not to bad records. One finding replaces the per-record findings.'),
  // consistency (temporal)
  'consistency.modified_before_created': R('consistency', 'modified_before_created', 'record', 'medium', {}, true, 'The modification date is earlier than the creation date.'),
  'consistency.future_date': R('consistency', 'future_date', 'record', 'high', {}, true, 'A date lies after the run reference date.'),
  // freshness
  'freshness.stale_record': R('freshness', 'stale_record', 'record', 'low', {}, true, 'The record has not changed for longer than the stale threshold (measured from the run reference date).'),
  // uniqueness (role-aware: only identifiers that MUST be unique for this dataset type)
  'uniqueness.identifier_repeated': R('uniqueness', 'duplicate_identifier', 'group', 'high', {}, true, 'An identifier that must be unique appears on more than one record.')
};
const RULE_IDS = Object.keys(RULES);
/** validators a validation profile may name -> the catalog rule that executes them */
const isRule = id => Object.prototype.hasOwnProperty.call(RULES, id);
module.exports = { RULE_ENGINE_VERSION, RULE_CATALOG_VERSION, SEVERITIES, CATEGORIES, RULES, RULE_IDS, PLACEHOLDERS, isRule };
