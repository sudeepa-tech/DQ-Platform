'use strict';
const taxonomy = require('./taxonomy'); const cfg = require('./config');
const { profileColumns, PROFILE_VERSION } = require('./contentProfile'); const { classifyColumns } = require('./roleClassifier'); const { classifyDataset } = require('./datasetClassifier');
const { resolveRequiredness, missingDisposition } = require('./requiredness'); const { buildValidationProfile, VALIDATION_PROFILE_VERSION } = require('./validationProfiles'); const { LEXICON_VERSION } = require('./headerAnalysis');
/** the whole semantic stage as one pure function: canonical columns + rows -> dataset type + per-column mappings (no database, no I/O) */
function analyzeSemantics(columns, rows, options = {}) {
  const config = cfg.resolveConfig(options.config); const profiles = profileColumns(columns, rows);
  return analyzeFromProfiles(columns, profiles, { ...options, config });
}
function analyzeFromProfiles(columns, profiles, options = {}) {
  const config = options.resolved ? options.config : cfg.resolveConfig(options.config);
  const mappings = classifyColumns(columns, profiles, config);
  const dataset = classifyDataset(mappings, config, options.datasetTypeOverride);
  const req = resolveRequiredness(mappings, profiles, dataset.dataset_type, config, options.requirednessOverrides || {});
  mappings.forEach((m, i) => { m.requiredness = req[i].requiredness; m.requiredness_source = req[i].source; m.requiredness_reason = req[i].reason; m.include_in_analysis = m.evidence.decision.empty_column && m.role === 'unknown' ? 0 : 1; m.validation_profile = buildValidationProfile(dataset.dataset_type, m, config); });
  return { dataset, mappings, profiles, versions: versions(config) };
}
const versions = config => ({ taxonomy: taxonomy.TAXONOMY_VERSION, engine: cfg.SEMANTIC_ENGINE_VERSION, config: config.version, config_hash: cfg.hashConfig(config), profile: PROFILE_VERSION, lexicon: LEXICON_VERSION, validation_profiles: VALIDATION_PROFILE_VERSION });
module.exports = { ...taxonomy, ...cfg, analyzeSemantics, analyzeFromProfiles, profileColumns, classifyColumns, classifyDataset, resolveRequiredness, missingDisposition, buildValidationProfile, versions };
