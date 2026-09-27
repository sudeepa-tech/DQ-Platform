'use strict';
/*
 * VALIDATION PROFILES: which validators later rule stages should run, per dataset type and ROLE. Validators are attached because of the role the
 * mapping settled on (confirmed by the user, or confident enough), NEVER because a header contains some substring. This stage only declares the
 * profile; executing the validators is the rule stage's job.
 */
const VALIDATION_PROFILE_VERSION = 'validation-profiles-1.0.0';
const V = (rule_id, params) => (params ? { rule_id, params } : { rule_id });
const DATES = { creation_date: [V('validity.date_calendar')], modification_date: [V('validity.date_calendar')], effective_date: [V('validity.date_calendar')], posting_date: [V('validity.date_calendar')], document_date: [V('validity.date_calendar')], time_of_day: [V('validity.time_of_day')] };
const INTRINSIC = { email: [V('validity.email_format')], phone: [V('validity.phone_format')], legal_id: [V('validity.legal_id_format', { schemes: ['gstin', 'pan'] })], tax_rate: [V('validity.percentage_range', { min: 0, max: 100 })], currency: [V('validity.currency_code')],
  // S4: an impossible (negative) quantity or price is impossible whatever the dataset type, so these checks are role-intrinsic too
  quantity: [V('validity.numeric_non_negative')], unit_price: [V('validity.numeric_non_negative')] };
const CATALOG = {
  master_entity: { ...DATES, ...INTRINSIC, entity_id: [V('validity.identifier_format')], postal_code: [V('validity.postal_code_format')], name: [V('validity.text_not_placeholder')] },
  master_material: { ...DATES, material_id: [V('validity.identifier_format')], description: [V('validity.text_not_placeholder')], uom: [V('validity.uom_known')], quantity: [V('validity.numeric_non_negative')], measure: [V('validity.numeric_non_negative')], unit_price: [V('validity.numeric_non_negative')], tax_rate: INTRINSIC.tax_rate, currency: INTRINSIC.currency },
  transaction: { ...DATES, doc_id: [V('validity.identifier_format')], doc_ref: [V('validity.identifier_format')], amount: [V('validity.numeric')], quantity: [V('validity.numeric_non_negative')], unit_price: [V('validity.numeric_non_negative')], tax_rate: INTRINSIC.tax_rate, currency: INTRINSIC.currency, line_item: [V('validity.identifier_format')] },
  mixed_unknown: { ...DATES, ...INTRINSIC }       // only role-intrinsic checks when the dataset type is not established
};
/** profile for one mapped column */
function buildValidationProfile(datasetType, mapping, cfg, userConfirmed = false) {
  const validators = (CATALOG[datasetType] || CATALOG.mixed_unknown)[mapping.role] || [];
  const id = `${VALIDATION_PROFILE_VERSION}/${datasetType}`;
  if (mapping.role === 'unknown') return { profile_id: id, status: 'not_applicable', validators: [], reason: 'role not identified: no validator is attached to an unidentified column' };
  if (!validators.length) return { profile_id: id, status: 'not_applicable', validators: [], reason: `no validators defined for ${mapping.role} in a ${datasetType} dataset` };
  const trusted = userConfirmed || (mapping.confidence_tier !== 'low' && !mapping.review_required);
  return { profile_id: id, status: trusted ? 'active' : 'pending_review', validators, reason: trusted ? `attached because the column is mapped to ${mapping.role}` : `held until the ${mapping.role} mapping is reviewed (${mapping.confidence_tier} confidence${mapping.review_required ? ', review required' : ''})` };
}
module.exports = { VALIDATION_PROFILE_VERSION, CATALOG, buildValidationProfile };
