#!/bin/bash
# S0: legacy-engine baselines for all validation datasets (real server, isolated storage). No production code touched.
cd "$(dirname "$0")/../.."
UP=${DQ_SAP_DIR:-/mnt/user-data/uploads}
R="node --experimental-sqlite qa/harness/run_baseline.js"
$R --data=qa/fixtures/ERP_DQ_Authenticity_Test_Dump.xlsx --sheet=ERP_Dump --label=erp_dump --truth=qa/oracle/truth/erp_dump.truth.json 2>&1 | grep "^\["
$R --data=qa/fixtures/holdout_master_entity.xlsx --sheet=Vendor_Master --label=holdout --truth=qa/oracle/truth/holdout.truth.json --expected_roles=qa/oracle/holdout.expected_roles.json 2>&1 | grep "^\["
$R --data=$UP/Material_Master_23_09_2026.xlsx --label=material_master --baseline=qa/oracle/truth/material_master.baseline.json 2>&1 | grep "^\["
$R --data=$UP/Service_Entry_Sheet_23_09_2026.xlsx --label=service_entry --baseline=qa/oracle/truth/service_entry.baseline.json 2>&1 | grep "^\["
