'use strict';
/*
 * Controlled vocabulary of the semantic layer. Roles are grouped into families; every role declares what CONTENT it needs (`needs`) and how risky a wrong
 * assignment is (`risk`): high-risk roles (phone, email, legal id, name, address, postal code, dates) are never assigned from a header alone.
 * Extensions beyond the product owner's minimum list are marked `extra: true` (line_item, entity_type, country, amount, measure, category, time_of_day):
 * they exist because real SAP files need them (an `Item` line number is not a material id; a `Gross Weight` is not an address).
 */
const TAXONOMY_VERSION = 'taxonomy-1.0.0';
const R = (family, needs, risk, extra = false, critical = false) => ({ family, needs, risk, extra, critical });
const ROLES = {
  // IDENTIFIERS
  legal_id: R('identifier', 'code', 'high', false, true), entity_id: R('identifier', 'code', 'medium', false, true), material_id: R('identifier', 'code', 'medium', false, true),
  doc_id: R('identifier', 'code', 'medium', false, true), doc_ref: R('identifier', 'code', 'medium', false, true), row_id: R('identifier', 'code', 'low', false, false),
  line_item: R('identifier', 'code', 'low', true),
  // PERSON / AUDIT
  audit_user: R('person_audit', 'text', 'medium'),
  // ENTITY ATTRIBUTES
  name: R('entity_attribute', 'text', 'high', false, true), entity_type: R('entity_attribute', 'text', 'low', true), address: R('entity_attribute', 'text', 'high'), city: R('entity_attribute', 'text', 'medium'),
  state: R('entity_attribute', 'text', 'medium'), country: R('entity_attribute', 'text', 'medium', true), postal_code: R('entity_attribute', 'code', 'high'),
  phone: R('entity_attribute', 'code', 'high'), email: R('entity_attribute', 'text', 'high'),
  // MATERIAL ATTRIBUTES (also carries commercial / transaction values)
  description: R('material_attribute', 'text', 'medium'), uom: R('material_attribute', 'code', 'low'), quantity: R('material_attribute', 'number', 'low'), unit_price: R('material_attribute', 'number', 'low'),
  tax_rate: R('material_attribute', 'number', 'low'), amount: R('material_attribute', 'number', 'low', true), measure: R('material_attribute', 'number', 'low', true), category: R('material_attribute', 'text', 'low', true),
  // DATES
  creation_date: R('date', 'date', 'high'), modification_date: R('date', 'date', 'high'), effective_date: R('date', 'date', 'high'), posting_date: R('date', 'date', 'high'), document_date: R('date', 'date', 'high'),
  time_of_day: R('date', 'time', 'medium', true),
  // OTHER
  currency: R('other', 'code', 'low'), payment_terms: R('other', 'text', 'low'), status: R('other', 'code', 'low'), unknown: R('other', 'any', 'low')
};
const ROLE_NAMES = Object.keys(ROLES);
const FAMILIES = [...new Set(Object.values(ROLES).map(r => r.family))];
const familyOf = role => (ROLES[role] ? ROLES[role].family : 'other');
const DATASET_TYPES = ['master_entity', 'master_material', 'transaction', 'mixed_unknown'];
const REQUIREDNESS = ['required', 'expected', 'optional'];
const REQUIREDNESS_SOURCES = ['inferred', 'user', 'rule', 'sap_domain'];
const MAPPING_STATUS = ['suggested', 'auto_accepted', 'confirmed', 'overridden', 'rejected'];
const isRole = r => Object.prototype.hasOwnProperty.call(ROLES, r);
const describeTaxonomy = () => ({ version: TAXONOMY_VERSION, families: FAMILIES.map(f => ({ family: f, roles: ROLE_NAMES.filter(r => ROLES[r].family === f).map(r => ({ role: r, needs: ROLES[r].needs, risk: ROLES[r].risk, critical_identity: ROLES[r].critical, extension: ROLES[r].extra })) })),
  dataset_types: DATASET_TYPES, requiredness: REQUIREDNESS, requiredness_sources: REQUIREDNESS_SOURCES, mapping_status: MAPPING_STATUS });
module.exports = { TAXONOMY_VERSION, ROLES, ROLE_NAMES, FAMILIES, familyOf, DATASET_TYPES, REQUIREDNESS, REQUIREDNESS_SOURCES, MAPPING_STATUS, isRole, describeTaxonomy };
