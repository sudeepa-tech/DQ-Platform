-- ============================================================================
-- 0004  S2 canonical ingest: additive columns + STRUCTURAL invariants only
-- ----------------------------------------------------------------------------
-- Additive. Triggers here enforce physical/structural facts (an ingested file, its physical columns and its source rows never change; lineage is
-- self-consistent). They deliberately encode NO business semantics: those belong to versioned analysis/rule configuration (see 0005).
-- ============================================================================

-- ---------------------------------------------------------------- source_files: ingest identity, header row, counts
ALTER TABLE source_files ADD COLUMN ingest_status TEXT NOT NULL DEFAULT 'not_ingested' CHECK (ingest_status IN ('not_ingested','ingested','failed'));
ALTER TABLE source_files ADD COLUMN ingest_error TEXT;
ALTER TABLE source_files ADD COLUMN ingest_fingerprint TEXT;      -- sha256 of everything that changes the canonical output (ingest/date-model version, header row, date profile, row-id setting, delimiter)
ALTER TABLE source_files ADD COLUMN ingest_config_json TEXT CHECK (ingest_config_json IS NULL OR json_valid(ingest_config_json));
ALTER TABLE source_files ADD COLUMN ingest_warnings_json TEXT CHECK (ingest_warnings_json IS NULL OR json_valid(ingest_warnings_json));
ALTER TABLE source_files ADD COLUMN header_row_source TEXT CHECK (header_row_source IS NULL OR header_row_source IN ('explicit','auto','default'));
ALTER TABLE source_files ADD COLUMN preamble_json TEXT CHECK (preamble_json IS NULL OR json_valid(preamble_json));   -- non-blank rows ABOVE the header, kept verbatim
ALTER TABLE source_files ADD COLUMN physical_row_count INTEGER;  -- rows in the sheet's used range
ALTER TABLE source_files ADD COLUMN data_row_count INTEGER;      -- data rows stored (blank rows are skipped, never renumbered)
ALTER TABLE source_files ADD COLUMN blank_row_count INTEGER;
ALTER TABLE source_files ADD COLUMN date1904 INTEGER CHECK (date1904 IS NULL OR date1904 IN (0,1));
ALTER TABLE source_files ADD COLUMN sheet_index INTEGER;
-- one ingested source per (dataset, content, sheet, fingerprint): re-uploading the same file never duplicates rows
CREATE UNIQUE INDEX IF NOT EXISTS uq_source_files_ingest_identity
  ON source_files(dataset_id, content_sha256, COALESCE(sheet_name, ''), ingest_fingerprint) WHERE ingest_status = 'ingested';

-- ---------------------------------------------------------------- file_columns: physical column provenance
ALTER TABLE file_columns ADD COLUMN header_normalized TEXT;      -- whitespace/case normalization only; the original stays in header_raw
ALTER TABLE file_columns ADD COLUMN column_letter TEXT;          -- Excel column letter of the physical column (column_index = position, A = 0)
ALTER TABLE file_columns ADD COLUMN source_sheet TEXT;
ALTER TABLE file_columns ADD COLUMN duplicate_ordinal INTEGER CHECK (duplicate_ordinal IS NULL OR duplicate_ordinal >= 1);   -- 1..n among physical columns sharing a normalized header

-- ---------------------------------------------------------------- source_rows: typed canonical values (raw stays in raw_json)
ALTER TABLE source_rows ADD COLUMN canonical_json TEXT CHECK (canonical_json IS NULL OR json_valid(canonical_json));

-- ---------------------------------------------------------------- structural invariants
CREATE TRIGGER IF NOT EXISTS trg_file_columns_physical_immutable
BEFORE UPDATE OF source_file_id, column_index, header_raw, header_key, header_normalized, column_letter, source_sheet, duplicate_ordinal, is_duplicate_header,
                 populated_count, populated_ratio, distinct_count, is_empty, cell_kinds_json, value_shapes_json, profile_json ON file_columns
BEGIN SELECT RAISE(ABORT, 'physical column facts of an ingested file are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_source_rows_canonical_immutable
BEFORE UPDATE OF canonical_json ON source_rows
BEGIN SELECT RAISE(ABORT, 'ingested source rows are immutable: re-ingest instead'); END;

CREATE TRIGGER IF NOT EXISTS trg_source_files_ingest_frozen
BEFORE UPDATE OF dataset_id, content_sha256, ingest_fingerprint, ingest_version, ingest_config_json, header_row, header_row_source, preamble_json, sheet_name,
                 physical_row_count, data_row_count, blank_row_count, date1904 ON source_files
WHEN OLD.ingest_status = 'ingested'
BEGIN SELECT RAISE(ABORT, 'an ingested source file is immutable: ingest the file again as a new source'); END;

CREATE TRIGGER IF NOT EXISTS trg_source_files_ingest_status_final
BEFORE UPDATE OF ingest_status ON source_files
WHEN OLD.ingest_status = 'ingested' AND NEW.ingest_status <> 'ingested'
BEGIN SELECT RAISE(ABORT, 'an ingested source file cannot be un-ingested'); END;

-- physical row lineage: sheet_row = header_row + row_number, and the stored sheet is the file's sheet (when both are known)
CREATE TRIGGER IF NOT EXISTS trg_source_rows_lineage_consistent
BEFORE INSERT ON source_rows
WHEN (NEW.sheet_row IS NOT NULL AND (SELECT header_row FROM source_files WHERE id = NEW.source_file_id) IS NOT NULL
      AND NEW.sheet_row <> NEW.row_number + (SELECT header_row FROM source_files WHERE id = NEW.source_file_id))
  OR (NEW.source_sheet IS NOT NULL AND NEW.source_sheet IS NOT (SELECT sheet_name FROM source_files WHERE id = NEW.source_file_id))
BEGIN SELECT RAISE(ABORT, 'source row lineage mismatch: sheet_row must equal header_row + row_number and source_sheet must be the file''s sheet'); END;
