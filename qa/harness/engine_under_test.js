'use strict';
/* Which engine each LAYER of the pipeline is tested against. Layers move from 'legacy' to 'v1' phase by phase (S2: ingest + dates).
   The legacy adapters stay runnable (QA_INGEST=legacy) so the recorded S0/S1 baselines can always be reproduced. */
/* S3: the SEMANTIC layer (roles, dataset type) is 'v1' too; QA_SEMANTIC=legacy restores the old header/substring profiler. */
/* S4: the RULES layer (completeness, validity, temporal, freshness, uniqueness findings) is 'v1' too; QA_RULES=legacy restores the legacy engine's own issues in the run view. */
module.exports = { ingest: process.env.QA_INGEST || 'v1', semantic: process.env.QA_SEMANTIC || 'v1', rules: process.env.QA_RULES || 'v1', identity: process.env.QA_IDENTITY || 'v1' };
