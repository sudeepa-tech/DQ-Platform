# legacy_v0 — QUARANTINED, NOT PART OF THE PRODUCTION PATH (since S6)

Reduced at S8: the actual defective code (analysisOrchestrator, jobQueue, matchingEngine, qualityEngine, conflictEngine,
healthScore, utils/normalize) has been REMOVED, along with their dedicated unit tests, since nothing referenced them except
those tests themselves. Removing dead code, not merely quarantining it, was the explicit S8 instruction.

What remains, and why: `fileParser.js` and `schemaProfiler.js` are still load-bearing for QA tooling --
`qa/harness/engine_facade.js` and `qa/harness/tz_child.js` use them to reproduce the ORIGINAL pre-framework parser/profiler
behavior, which the timezone matrix (RT-06) and the legacy-baseline comparison need for a faithful historical reference.
They are exercised only by `qa/harness/*` and their own `backend/tests/schemaProfiler.test.js`; nothing under `backend/src`
or `frontend/src` may import from here (enforced by a static guard, `qa/regression/rt13_semantic_layer.test.js`).

The recorded S0/S1 baselines (`qa/fixtures/legacy/legacy_v0.db`, `qa/baseline/legacy/*`) and RT-11's migration-continuity
proof do not need the removed files at all: they compare against a static, pre-built snapshot, not a live re-run of the
old orchestrator.
