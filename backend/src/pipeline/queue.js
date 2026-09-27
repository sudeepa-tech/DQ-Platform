'use strict';
/* Simple sequential in-process queue (mirrors the pre-S6 jobQueue.js, now driving the real pipeline). Adequate for a single-node
   deployment; the job/run rows already model what a real broker (BullMQ/Redis) would need if horizontal scale is required later. */
const { executeRun } = require('./runPipeline');
const db = require('../db');
const queue = []; let processing = false;

function enqueueRun(runId, jobId) { queue.push({ runId, jobId }); processNext(); }
async function processNext() {
  if (processing) return; const next = queue.shift(); if (!next) return; processing = true;
  try { await executeRun(db, { runId: next.runId, jobId: next.jobId, todayISO: new Date().toISOString().slice(0, 10) }); }
  catch (e) { console.error(`Analysis run ${next.runId} failed:`, e.message); }
  finally { processing = false; if (queue.length) setImmediate(processNext); }
}
module.exports = { enqueueRun };
