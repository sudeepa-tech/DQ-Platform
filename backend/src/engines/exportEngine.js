'use strict';
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const db = require('../db');

const EXPORT_DIR = require('../config/paths').EXPORT_DIR;
if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });

function simpleCsv(rows) {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    s = sanitizeFormulaValue(s);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map(h => escape(row[h])).join(','));
  return lines.join('\n');
}

// ---- CSV / spreadsheet formula-injection protection (OWASP CSV Injection) ----
// A cell value that begins with =, +, -, @, or a tab/CR character is treated
// as a formula by Excel/LibreOffice/Google Sheets when the exported file is
// opened, which can be abused for data exfiltration or remote code execution
// via DDE. Source data (vendor names, addresses, item descriptions) comes
// from uploaded SAP/ERP files, i.e. is attacker-influenceable, so every
// exported cell must be neutralized regardless of format. Prefixing with a
// single quote is the standard mitigation: spreadsheet applications render
// the value as literal text instead of evaluating it, and the quote is not
// visible to the end user once opened.
const FORMULA_TRIGGER_RE = /^[=+\-@\t\r]/;
function sanitizeFormulaValue(value) {
  if (typeof value !== 'string') return value;
  return FORMULA_TRIGGER_RE.test(value) ? `'${value}` : value;
}

function businessKeyOf(bizJson) { if (!bizJson) return ''; try { return Object.values(JSON.parse(bizJson)).filter(Boolean).join(' | '); } catch (_) { return ''; } }

function fetchDataForExportType(runId, exportType) {
  switch (exportType) {
    case 'issues':
      return db.prepare(`SELECT qi.category, qi.issue_type, qi.severity, qi.field_name, qi.explanation, qi.detection_method, qi.confidence,
          r.primary_name as record_name, r.row_identifier as source_row_id, r.business_key_json, qi.row_number as source_row_number,
          COALESCE(qi.source_sheet, r.source_sheet) as source_sheet, sf.original_filename as source_file
        FROM quality_issues qi
        LEFT JOIN records r ON r.id = qi.record_id
        LEFT JOIN source_files sf ON sf.id = COALESCE(qi.source_file_id, r.source_file_id)
        WHERE qi.run_id = ? ORDER BY qi.severity`).all(runId).map(r => ({ ...r, business_key: businessKeyOf(r.business_key_json), business_key_json: undefined }));

    case 'duplicates':
    case 'clusters':
      return db.prepare(`SELECT ec.id as cluster_id, ec.cluster_kind, ec.match_class, ec.match_subtype, ec.representative_name, ec.record_count, ec.confidence, ec.review_status,
          ec.matching_factors_json, ec.conflicts_json, r.primary_name as member_name, r.source_row_ref, r.row_identifier as source_row_id, r.business_key_json,
          r.source_sheet, sf.original_filename as source_file
        FROM entity_clusters ec
        JOIN entity_cluster_members ecm ON ecm.cluster_id = ec.id
        JOIN records r ON r.id = ecm.record_id
        LEFT JOIN source_files sf ON sf.id = r.source_file_id
        WHERE ec.run_id = ? ORDER BY ec.confidence DESC`).all(runId).map(r => ({
          ...r,
          matching_factors: JSON.parse(r.matching_factors_json || '[]').join('; '),
          conflicts: JSON.parse(r.conflicts_json || '[]').join('; '),
          business_key: businessKeyOf(r.business_key_json),
          matching_factors_json: undefined, conflicts_json: undefined, business_key_json: undefined
        }));

    case 'conflicts':
      return db.prepare(`SELECT cg.conflict_type, cg.severity, cg.subject_role, cg.subject_value, cg.explanation, cg.member_count,
          r.primary_name as member_name, r.row_identifier as source_row_id, r.business_key_json, r.source_sheet, sf.original_filename as source_file, cgm.member_role
        FROM conflict_groups cg
        JOIN conflict_group_members cgm ON cgm.conflict_group_id = cg.id
        JOIN records r ON r.id = cgm.record_id
        LEFT JOIN source_files sf ON sf.id = r.source_file_id
        WHERE cg.run_id = ?
        UNION ALL
        SELECT c.conflict_type, c.severity, c.field_name as subject_role, c.shared_value as subject_value, c.explanation, json_array_length(c.record_ids_json) as member_count,
          r.primary_name as member_name, r.row_identifier as source_row_id, r.business_key_json, r.source_sheet, sf.original_filename as source_file, 'member' as member_role
        FROM conflicts c JOIN json_each(c.record_ids_json) je ON 1=1 LEFT JOIN records r ON r.id = je.value LEFT JOIN source_files sf ON sf.id = r.source_file_id
        WHERE c.run_id = ? AND NOT EXISTS (SELECT 1 FROM conflict_groups WHERE run_id = c.run_id)`).all(runId, runId)
        .map(r => ({ ...r, business_key: businessKeyOf(r.business_key_json), business_key_json: undefined }));

    case 'missing':
      return db.prepare(`SELECT r.primary_name as record_name, r.row_identifier as source_row_id, r.business_key_json, r.source_sheet, sf.original_filename as source_file, qi.field_name, qi.explanation
        FROM quality_issues qi LEFT JOIN records r ON r.id = qi.record_id LEFT JOIN source_files sf ON sf.id = COALESCE(qi.source_file_id, r.source_file_id)
        WHERE qi.run_id = ? AND qi.category = 'completeness'`).all(runId).map(r => ({ ...r, business_key: businessKeyOf(r.business_key_json), business_key_json: undefined }));

    case 'invalid':
      return db.prepare(`SELECT r.primary_name as record_name, r.row_identifier as source_row_id, r.business_key_json, r.source_sheet, sf.original_filename as source_file, qi.field_name, qi.explanation
        FROM quality_issues qi LEFT JOIN records r ON r.id = qi.record_id LEFT JOIN source_files sf ON sf.id = COALESCE(qi.source_file_id, r.source_file_id)
        WHERE qi.run_id = ? AND qi.category = 'validity'`).all(runId).map(r => ({ ...r, business_key: businessKeyOf(r.business_key_json), business_key_json: undefined }));

    case 'stale':
      return db.prepare(`SELECT primary_name as record_name, row_identifier as source_row_id, business_key_json, source_sheet, created_date, modified_date FROM records
        WHERE run_id = ? AND id IN (SELECT record_id FROM quality_issues WHERE run_id = ? AND issue_type = 'stale_record')`).all(runId, runId)
        .map(r => ({ ...r, business_key: businessKeyOf(r.business_key_json), business_key_json: undefined }));

    case 'normalized':
      return db.prepare(`SELECT primary_name, source_row_ref, row_identifier as source_row_id, source_sheet, raw_json FROM records WHERE run_id = ?`).all(runId)
        .map(r => ({ primary_name: r.primary_name, source_row_ref: r.source_row_ref, source_row_id: r.source_row_id, source_sheet: r.source_sheet, ...JSON.parse(r.raw_json) }));

    case 'summary': {
      const run = db.prepare('SELECT * FROM analysis_runs WHERE id = ?').get(runId);
      return [{
        health_score: run.health_score,
        scoring_status: run.health_score === null ? 'pending (S7)' : 'computed',
        records_analyzed: run.records_analyzed,
        status: run.status,
        engine_version: run.engine_version,
        config_id: run.config_id,
        started_at: run.started_at,
        finished_at: run.finished_at
      }];
    }

    case 'full_analysis': {
      // handled specially (multi-sheet) by caller
      return null;
    }
    default:
      throw new Error(`Unknown export type: ${exportType}`);
  }
}

async function generateExport({ runId, exportType, format }) {
  const { v4: uuid } = require('uuid');
  const exportId = uuid();
  const baseName = `${exportType}_${runId.slice(0, 8)}_${Date.now()}`;

  if (format === 'json') {
    const data = exportType === 'full_analysis' ? fullAnalysisJson(runId) : fetchDataForExportType(runId, exportType);
    const filePath = path.join(EXPORT_DIR, `${baseName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return persistExport(exportId, runId, exportType, format, filePath);
  }

  if (format === 'csv') {
    if (exportType === 'full_analysis') throw new Error('full_analysis export requires xlsx or json format (multiple sheets).');
    const data = fetchDataForExportType(runId, exportType);
    const filePath = path.join(EXPORT_DIR, `${baseName}.csv`);
    fs.writeFileSync(filePath, simpleCsv(data));
    return persistExport(exportId, runId, exportType, format, filePath);
  }

  if (format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    if (exportType === 'full_analysis') {
      const sections = ['summary', 'issues', 'duplicates', 'conflicts', 'missing', 'invalid', 'stale'];
      for (const section of sections) {
        const data = fetchDataForExportType(runId, section);
        addSheet(wb, section, data);
      }
    } else {
      const data = fetchDataForExportType(runId, exportType);
      addSheet(wb, exportType, data);
    }
    const filePath = path.join(EXPORT_DIR, `${baseName}.xlsx`);
    await wb.xlsx.writeFile(filePath);
    return persistExport(exportId, runId, exportType, format, filePath);
  }

  throw new Error(`Unsupported export format: ${format}`);
}

function addSheet(workbook, name, data) {
  const sheet = workbook.addWorksheet(name.slice(0, 31));
  if (!data || data.length === 0) {
    sheet.addRow(['No data for this section.']);
    return;
  }
  const headers = Object.keys(data[0]);
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true };
  for (const row of data) sheet.addRow(headers.map(h => sanitizeFormulaValue(row[h])));
  sheet.columns.forEach(col => { col.width = 22; });
}

function fullAnalysisJson(runId) {
  const run = db.prepare('SELECT * FROM analysis_runs WHERE id = ?').get(runId);
  return {
    run,
    issues: fetchDataForExportType(runId, 'issues'),
    duplicates: fetchDataForExportType(runId, 'duplicates'),
    conflicts: fetchDataForExportType(runId, 'conflicts'),
    missing: fetchDataForExportType(runId, 'missing'),
    invalid: fetchDataForExportType(runId, 'invalid'),
    stale: fetchDataForExportType(runId, 'stale')
  };
}

function persistExport(exportId, runId, exportType, format, filePath) {
  db.prepare('INSERT INTO exports (id, run_id, export_type, format, file_path) VALUES (?,?,?,?,?)').run(exportId, runId, exportType, format, filePath);
  return db.prepare('SELECT * FROM exports WHERE id = ?').get(exportId);
}

module.exports = { generateExport, sanitizeFormulaValue, simpleCsv };
