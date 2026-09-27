#!/usr/bin/env python3
"""Independent S2 truth (openpyxl, NOT SheetJS): physical columns, full-column populated/distinct facts, per-cell date/time truth and exact raw
values of identifier/audit columns, read straight from the workbook cells. Nothing here passes through the code under test or any timezone logic.
usage: python3 qa/oracle/ingest_truth.py [uploads_dir]   -> qa/oracle/truth/ingest.truth.json"""
import json, re, sys, datetime as dt, openpyxl
from openpyxl.utils import get_column_letter
UP = sys.argv[1] if len(sys.argv) > 1 else "/mnt/user-data/uploads"
SPEC = [("service_entry", f"{UP}/Service_Entry_Sheet_23_09_2026.xlsx", None, ["Entry Sheet", "Purchasing Document", "Created By", "Changed By", "Item"]),
        ("material_master", f"{UP}/Material_Master_23_09_2026.xlsx", None, ["Material", "Created By"]),
        ("holdout", "qa/fixtures/holdout_master_entity.xlsx", "Vendor_Master", []),
        ("erp_dump", "qa/fixtures/ERP_DQ_Authenticity_Test_Dump.xlsx", "ERP_Dump", ["Record_ID"])]
def kind(v):
    if v is None: return "blank"
    if isinstance(v, bool): return "bool"
    if isinstance(v, dt.datetime): return "date" if v.time() == dt.time(0, 0, 0) else "datetime"
    if isinstance(v, dt.date): return "date"
    if isinstance(v, dt.time): return "time"
    if isinstance(v, (int, float)): return "number"
    if isinstance(v, str): return "blank" if v == "" else ("whitespace" if v.strip() == "" else "text")
    return "other"
def iso(v):
    if isinstance(v, dt.datetime): return v.strftime("%Y-%m-%d") if v.time() == dt.time(0, 0, 0) else v.strftime("%Y-%m-%dT%H:%M:%S")
    if isinstance(v, dt.date): return v.strftime("%Y-%m-%d")
    if isinstance(v, dt.time): return v.strftime("%H:%M:%S")
    return None
def valid(y, m, d):
    try: dt.date(y, m, d); return True
    except ValueError: return False
DOT = re.compile(r"^(\d{1,2})\.(\d{1,2})\.(\d{4})$"); ISO = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$"); SLASH = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})$")
DASH = re.compile(r"^(\d{1,2})-(\d{1,2})-(\d{4})$"); DOT2 = re.compile(r"^(\d{1,2})\.(\d{1,2})\.(\d{2})$")
def text_date_facts(strings):
    """Independent classification of TEXT cells by pattern + calendar validity (python datetime.date), for the default profile
    [DD.MM.YYYY, YYYY-MM-DD]. parsed = valid under an enabled format; invalid = enabled-format shape but impossible; needs_configuration = valid only under a
    NOT-enabled format (slash / dash / two-digit year); everything else is plain text."""
    f = dict(parsed=0, invalid=0, needs_configuration=0, plain_text=0)
    for v in strings:
        v = v.strip(); m = DOT.match(v) or ISO.match(v)
        if m:
            a, b, c = (int(x) for x in m.groups())
            ok = valid(c, b, a) if DOT.match(v) else valid(a, b, c)
            f["parsed" if ok else "invalid"] += 1; continue
        m = SLASH.match(v) or DASH.match(v)
        if m:
            a, b, c = (int(x) for x in m.groups())
            if valid(c, b, a) or valid(c, a, b): f["needs_configuration"] += 1; continue
        m = DOT2.match(v)
        if m:
            a, b, c = (int(x) for x in m.groups())
            if 1 <= b <= 12 and 1 <= a <= (29 if b == 2 else 31): f["needs_configuration"] += 1; continue   # day/month plausible; the century is unknowable
        f["plain_text"] += 1
    return f
out = {}
for name, path, sheet, raw_cols in SPEC:
    wb = openpyxl.load_workbook(path, data_only=True); ws = wb[sheet] if sheet else wb.worksheets[0]
    grid = [[c.value for c in row] for row in ws.iter_rows(min_row=1, max_row=ws.max_row, max_col=ws.max_column)]
    hdr = [("" if h is None else str(h)) for h in grid[0]]; data = grid[1:]
    cols = []
    for i, h in enumerate(hdr):
        vals = [r[i] for r in data]; ks = [kind(v) for v in vals]; counts = {}
        for k in ks: counts[k] = counts.get(k, 0) + 1
        populated = sum(1 for k in ks if k not in ("blank", "whitespace"))
        distinct = len({(kind(v), iso(v) if iso(v) else v) for v, k in zip(vals, ks) if k not in ("blank", "whitespace")})
        col = dict(index=i, letter=get_column_letter(i + 1), header=h, populated=populated, distinct=distinct, kinds={k: n for k, n in counts.items() if k != "blank"})
        if any(k in ("date", "datetime", "time") for k in ks): col["temporal"] = [iso(v) if k in ("date", "datetime", "time") else None for v, k in zip(vals, ks)]
        tx = [v for v, k in zip(vals, ks) if k == "text"]; tf = text_date_facts(tx) if tx else None
        if tf and (tf["parsed"] or tf["invalid"] or tf["needs_configuration"]): col["text_dates"] = tf
        cols.append(col)
    raw = {}
    for h in raw_cols:
        idxs = [i for i, x in enumerate(hdr) if x == h]
        raw[h] = [[(None if r[i] is None else (r[i] if isinstance(r[i], (str, int, float)) else str(r[i]))) for r in data] for i in idxs]
    out[name] = dict(file=path.split("/")[-1], sheet=ws.title, physical_columns=len(hdr), data_rows=len(data), empty_columns=sum(1 for c in cols if c["populated"] == 0),
                     header=hdr, columns=cols, raw_columns=raw)
json.dump(out, open("qa/oracle/truth/ingest.truth.json", "w"), separators=(",", ":"))
print({k: (v["physical_columns"], v["data_rows"], v["empty_columns"], sum(1 for c in v["columns"] if "temporal" in c)) for k, v in out.items()})
