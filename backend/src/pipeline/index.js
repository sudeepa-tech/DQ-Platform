'use strict';
const PIPELINE_ENGINE_VERSION = 'pipeline-1.0.0';   // the v1 production pipeline: ingest -> confirmed mapping -> S4 rules -> S5 identity -> persisted findings
module.exports = { PIPELINE_ENGINE_VERSION, ...require('./runPipeline'), ...require('./queue'), ...require('./datasetStatus') };
