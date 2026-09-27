'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { purgeEligibleFiles, fileRetentionStatus } = require('../pipeline/retention');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// Manual trigger (also run automatically on a periodic sweep, see server.js). Organization-scoped: an admin can only
// purge their own organization's files, even though the underlying mechanism has no cross-organization data to leak
// (it only ever touches this organization's stored_path values).
router.post('/purge-files', (req, res) => {
  const { retention_days } = req.body || {};
  const result = purgeEligibleFiles(db, { retentionDays: retention_days, organizationId: req.user.org });
  res.json(result);
});

router.get('/retention-status', (req, res) => {
  const files = db.prepare(`SELECT sf.* FROM source_files sf JOIN datasets d ON d.id = sf.dataset_id WHERE d.organization_id = ?`).all(req.user.org);
  res.json({ files: files.map(f => ({ id: f.id, original_filename: f.original_filename, uploaded_at: f.uploaded_at, ...fileRetentionStatus(f) })), retention_days: Number(process.env.FILE_RETENTION_DAYS || 90) });
});

module.exports = router;
