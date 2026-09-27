#!/usr/bin/env python3
"""Independent date truth: calendar dates as stored in the workbook cells (openpyxl), never passed through any timezone logic."""
import json, sys, datetime as dt, openpyxl
UP = sys.argv[1] if len(sys.argv) > 1 else "/mnt/user-data/uploads"
SPEC = [("service_entry", f"{UP}/Service_Entry_Sheet_23_09_2026.xlsx", None, ["Created On", "Changed On", "Posting Date", "Document Date"]),
        ("material_master", f"{UP}/Material_Master_23_09_2026.xlsx", None, ["Created On"]),
        ("holdout", "qa/fixtures/holdout_master_entity.xlsx", "Vendor_Master", ["Created On"]),
        ("erp_dump", "qa/fixtures/ERP_DQ_Authenticity_Test_Dump.xlsx", "ERP_Dump", ["Creation_Date"])]
out = {}
for name, path, sheet, cols in SPEC:
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True); ws = wb[sheet] if sheet else wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True)); hdr = [str(h) for h in rows[0]]; first = {}
    for i, h in enumerate(hdr): first.setdefault(h, i)
    out[name] = dict(file=path.split("/")[-1], sheet=sheet or wb.sheetnames[0], columns={})
    for c in cols:
        vals = []
        for r in rows[1:]:
            v = r[first[c]]
            vals.append(v.strftime("%Y-%m-%d") if isinstance(v, (dt.datetime, dt.date)) else (None if v is None else str(v)))
        out[name]["columns"][c] = vals
json.dump(out, open("qa/oracle/truth/dates.truth.json", "w"))
print({k: {c: len(v) for c, v in d["columns"].items()} for k, d in out.items()})
