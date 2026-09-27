'use strict';
const express = require('express');
const path = require('path');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { generateExport } = require('../engines/exportEngine');

const router = express.Router();
router.use(requireAuth);

const VALID_TYPES = ['full_analysis', 'issues', 'duplicates', 'clusters', 'conflicts', 'missing', 'invalid', 'stale', 'normalized', 'summary'];
const VALID_FORMATS = ['xlsx', 'csv', 'json'];

router.post('/runs/:runId/export', async (req, res) => {
  const run = db.prepare(`SELECT ar.* FROM analysis_runs ar JOIN datasets d ON d.id = ar.dataset_id WHERE ar.id = ? AND d.organization_id = ?`)
    .get(req.params.runId, req.user.org);
  if (!run) return res.status(404).json({ error: 'Analysis run not found.' });
  if (run.status !== 'complete') return res.status(400).json({ error: 'This analysis run has not completed yet.' });

  const { export_type, format } = req.body || {};
  if (!VALID_TYPES.includes(export_type)) return res.status(400).json({ error: `export_type must be one of: ${VALID_TYPES.join(', ')}` });
  if (!VALID_FORMATS.includes(format)) return res.status(400).json({ error: `format must be one of: ${VALID_FORMATS.join(', ')}` });

  try {
    const exportRow = await generateExport({ runId: run.id, exportType: export_type, format });
    res.status(201).json({ export: exportRow, download_url: `/api/exports/${exportRow.id}/download` });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/exports/:id/download', (req, res) => {
  const exportRow = db.prepare(`SELECT e.* FROM exports e
    JOIN analysis_runs ar ON ar.id = e.run_id JOIN datasets d ON d.id = ar.dataset_id
    WHERE e.id = ? AND d.organization_id = ?`).get(req.params.id, req.user.org);
  if (!exportRow) return res.status(404).json({ error: 'Export not found.' });
  res.download(exportRow.file_path, path.basename(exportRow.file_path));
});

module.exports = router;
