#!/usr/bin/env python3
"""
S0 baselines for the two real SAP exports. INDEPENDENT of the engine (openpyxl cell metadata + pandas).

Outputs (no row data is copied into the repo; only headers, statistics, value SHAPES and business-key lists needed for
record-level validation):
  qa/fixtures/headers/<name>.headers.json        header list + per-column populated ratio, Excel cell kinds, value shapes
  qa/oracle/truth/<name>.baseline.json           independent facts + PRE-REGISTERED role expectations (must_map / must_not_map)

These are BASELINES (verifiable populations), not labelled ground truth: SAP exports carry no duplicate labels.
"""
import sys, re, json, difflib, datetime as dt
from collections import Counter, defaultdict
import openpyxl, pandas as pd

UP = sys.argv[1] if len(sys.argv) > 1 else "/mnt/user-data/uploads"

def kind(v):
    if v is None or (isinstance(v, str) and v.strip() == ""): return "empty"
    if isinstance(v, dt.datetime): return "date" if (v.hour, v.minute, v.second) == (0, 0, 0) else "timestamp"
    if isinstance(v, dt.date): return "date"
    if isinstance(v, dt.time): return "time"
    if isinstance(v, bool): return "bool"
    if isinstance(v, (int, float)): return "number"
    return "text"

def shape(v):
    s = str(v)[:24]
    return re.sub(r"[a-z]", "a", re.sub(r"[A-Z]", "A", re.sub(r"\d", "9", s)))

def profile(path, name):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True); ws = wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True)); hdr = [str(h) for h in rows[0]]; data = rows[1:]; n = len(data)
    cols = []
    for j, h in enumerate(hdr):
        vals = [r[j] if j < len(r) else None for r in data]; ks = Counter(kind(v) for v in vals)
        pop = [v for v in vals if kind(v) != "empty"]; strs = [str(v).strip() for v in pop]
        # text cells that parse as dd.mm.yyyy (SAP text dates)
        textdate = sum(1 for v in pop if isinstance(v, str) and re.fullmatch(r"\d{2}\.\d{2}\.\d{4}", v.strip()))
        cols.append(dict(index=j, header=h, populated_ratio=len(pop) / n, state=("empty" if not pop else "populated" if len(pop) / n >= .95 else "sparse"),
                         excel_kinds=dict(ks), text_dd_mm_yyyy=textdate, distinct=len(set(strs)), unique_ratio=(len(set(strs)) / len(pop) if pop else 0),
                         top_shapes=Counter(shape(v) for v in pop).most_common(3)))
    dup_headers = [h for h, c in Counter(x.lower() for x in hdr).items() if c > 1]
    return hdr, data, cols, dup_headers, n

def norm_desc(s):
    t = str(s).lower(); t = re.sub(r"(\d)\s*(mm|cm|m|kg|g|ml|l|x)\b", r"\1\2", t); t = re.sub(r"\s*x\s*", "x", t)
    return re.sub(r"[^a-z0-9.x ]", " ", re.sub(r"\s+", " ", t)).strip()

def nums(s): return sorted({x.lstrip("0") or "0" for x in re.findall(r"\d+(?:\.\d+)?", s)})

# ------------------------------------------------------------------ Material Master
hdr, data, cols, duph, n = profile(f"{UP}/Material_Master_23_09_2026.xlsx", "material_master")
json.dump(dict(file="Material_Master_23_09_2026.xlsx", rows=n, columns=cols, duplicate_headers_case_insensitive=duph), open("qa/fixtures/headers/material_master.headers.json", "w"), indent=1)
ci = {}
for _i, _h in enumerate(hdr): ci.setdefault(_h, _i)   # FIRST occurrence (duplicate headers exist in both files)
mat = [str(r[ci["Material"]]) for r in data]
desc_col = ci["Material Description"]
desc = [norm_desc(r[desc_col]) for r in data]
groups = defaultdict(list)
for m, d in zip(mat, desc): groups[d].append(m)
exact_desc_groups = [dict(normalized_description=d, materials=v) for d, v in groups.items() if len(v) > 1]
# near-duplicate candidate population (fuzzy >=0.94, identical numeric/dimension tokens, different material number) -- for MANUAL REVIEW, not truth
blocks = defaultdict(list)
for m, d in zip(mat, desc): blocks[tuple(nums(d))].append((m, d))
near = []
for k, v in blocks.items():
    for i in range(len(v)):
        for j in range(i + 1, len(v)):
            if v[i][1] != v[j][1] and difflib.SequenceMatcher(None, v[i][1], v[j][1]).ratio() >= 0.94:
                near.append(dict(a=v[i][0], b=v[j][0], ratio=round(difflib.SequenceMatcher(None, v[i][1], v[j][1]).ratio(), 3), da=v[i][1], db=v[j][1]))
created = [r[ci["Created On"]] for r in data if r[ci["Created On"]]]
mm = dict(
    meta=dict(file="Material_Master_23_09_2026.xlsx", rows=n, columns=len(hdr), kind="baseline (no labels)"),
    facts=dict(empty_columns=sum(1 for c in cols if c["state"] == "empty"), populated_columns=sum(1 for c in cols if c["state"] == "populated"),
               sparse_columns=sum(1 for c in cols if c["state"] == "sparse"), duplicate_headers_case_insensitive=duph,
               material_key_unique=len(set(mat)) == n, distinct_materials=len(set(mat)),
               last_change_populated=[c["populated_ratio"] for c in cols if c["header"] == "Last Change"],
               created_on_range=[str(min(created)), str(max(created))], created_on_kinds=[c["excel_kinds"] for c in cols if c["header"] == "Created On"][0],
               created_at_time_kinds=[c["excel_kinds"] for c in cols if c["header"] == "Created At Time"][0]),
    material_duplicates=dict(exact_normalized_description_groups=exact_desc_groups, group_count=len(exact_desc_groups), rows_involved=sum(len(g["materials"]) for g in exact_desc_groups),
                             near_duplicate_review_population=near[:300], near_duplicate_review_count=len(near),
                             note="exact groups = the population an engine MUST surface as material_match candidates; near list = must be explainable, sampled manually"),
    expected_roles=dict(
        must_map={"Material": ["material_key"], "Material Description": ["material_description"], "Material description": ["material_description"],
                  "Created On": ["created_date"], "Created By": ["audit_user"], "Base Unit of Measure": ["uom"], "Material Type": ["material_type", "category"],
                  "Material Group": ["category", "material_group"]},
        must_not_map={"Material": ["phone", "quantity", "date"], "Product allocation": ["address", "city", "phone"], "Maximum Capacity": ["address", "city"], "Load Capacity": ["address", "city"],
                      "Intellectual Property": ["phone"], "Form Name": ["entity_name"], "DF at client level": ["entity_name"], "Push Deployment from Supplier": ["entity_name"],
                      "Created By": ["created_date", "modified_date", "date"], "Created At Time": ["created_date", "date"]},
        empty_columns_must_not_generate_record_issues=True,
        modification_semantics="'Last Change' is 100% empty = never changed (SAP). Must NOT yield per-record missing-modification issues; freshness ages from creation.",
        no_column_may_be_mapped_to=["entity_name", "gstin", "email", "phone", "address"]))
json.dump(mm, open("qa/oracle/truth/material_master.baseline.json", "w"), indent=1)

# ------------------------------------------------------------------ Service Entry Sheet
hdr, data, cols, duph, n = profile(f"{UP}/Service_Entry_Sheet_23_09_2026.xlsx", "service_entry")
json.dump(dict(file="Service_Entry_Sheet_23_09_2026.xlsx", rows=n, columns=cols, duplicate_headers_case_insensitive=duph), open("qa/fixtures/headers/service_entry.headers.json", "w"), indent=1)
ci = {}
for _i, _h in enumerate(hdr): ci.setdefault(_h, _i)   # FIRST occurrence (duplicate headers exist in both files)
def dedupe(h):
    seen = Counter(); out = []
    for x in h:
        out.append(x if seen[x] == 0 else f"{x}.{seen[x]}"); seen[x] += 1
    return out
uh = dedupe(hdr)
exact_dup_headers = [h for h, c in Counter(hdr).items() if c > 1]
df = pd.DataFrame(data, columns=uh).astype(object)
key = "Entry Sheet"
tuple_cols = ["Purchasing Document", "Item", "Gross Value", "Posting Date"]
tg = df[df[tuple_cols].notna().all(axis=1)].groupby(tuple_cols, dropna=False).agg(n=(key, "size"), keys=(key, lambda s: [str(x) for x in s])).reset_index()
tg = tg[tg["n"] > 1]
biz_cols = [u for u, o, cc in zip(uh, hdr, cols) if o != key and cc["state"] != "empty"]
exact_biz = int(df[biz_cols].astype(str).duplicated(keep=False).sum())
textdate_cols = [c["header"] for c in cols if c["text_dd_mm_yyyy"] > 0.9 * n]
datecols = [c["header"] for c in cols if c["excel_kinds"].get("date", 0) > 0.9 * n]
se = dict(
    meta=dict(file="Service_Entry_Sheet_23_09_2026.xlsx", rows=n, columns=len(hdr), kind="baseline (no labels)"),
    facts=dict(empty_columns=sum(1 for c in cols if c["state"] == "empty"), entry_sheet_unique=bool(df[key].is_unique), distinct_entry_sheets=int(df[key].nunique()),
               purchasing_document_distinct=int(df["Purchasing Document"].nunique()), purchasing_document_rows_in_repeats=int(df["Purchasing Document"].duplicated(keep=False).sum()),
               excel_date_columns=datecols, text_dd_mm_yyyy_columns=textdate_cols, has_material_column=any("material" in h.lower() for h in hdr), exact_duplicate_headers=exact_dup_headers,
               exact_business_duplicate_rows_excluding_entry_sheet=exact_biz),
    transaction_duplicates=dict(
        expected_exact_document_key_duplicates=0,
        expected_exact_business_duplicates=exact_biz,
        near_duplicate_tuple_groups_po_item_gross_postingdate=[dict(entry_sheets=r["keys"], po=str(r["Purchasing Document"]), item=str(r["Item"]), gross=str(r["Gross Value"]), posting=str(r["Posting Date"])) for _, r in tg.iterrows()],
        note="expected transaction_duplicate count for exact document-key duplicates is 0; near-duplicate tuples are informational review candidates"),
    expected_roles=dict(
        must_map={"Entry Sheet": ["doc_key"], "Purchasing Document": ["doc_ref"], "Created On": ["created_date"], "Changed On": ["modified_date"],
                  "Created By": ["audit_user"], "Changed By": ["audit_user"], "Gross Value": ["amount"], "Net Value": ["amount"], "Currency": ["currency"], "Item": ["line_item"]},
        must_not_map={"Entry Sheet": ["phone", "quantity"], "Purchasing Document": ["phone"], "Created By": ["created_date", "modified_date", "date"], "Changed By": ["modified_date", "date"],
                      "Short Text": ["entity_name"], "Pers. Rsp. (Internally)": ["modified_date", "created_date"], "Person Resp. (Externally)": ["modified_date", "created_date"]},
        must_require_review={"Pers. Rsp. (Internally)": "header says person-responsible, content is 100% text dd.mm.yyyy dates (header/content conflict)",
                             "Person Resp. (Externally)": "same"},
        no_column_may_be_mapped_to=["material_key", "entity_name", "gstin", "email", "address_street"]))
json.dump(se, open("qa/oracle/truth/service_entry.baseline.json", "w"), indent=1)
print("material_master:", json.dumps({k: mm["facts"][k] for k in ("empty_columns", "populated_columns", "sparse_columns", "material_key_unique", "created_on_range")}),
      "| exact-desc groups:", mm["material_duplicates"]["group_count"], "rows:", mm["material_duplicates"]["rows_involved"], "| near-dup review pop:", mm["material_duplicates"]["near_duplicate_review_count"])
print("service_entry:", json.dumps({k: se["facts"][k] for k in ("empty_columns", "entry_sheet_unique", "purchasing_document_distinct", "excel_date_columns", "text_dd_mm_yyyy_columns", "has_material_column", "exact_business_duplicate_rows_excluding_entry_sheet")}),
      "| near-dup tuple groups:", len(se["transaction_duplicates"]["near_duplicate_tuple_groups_po_item_gross_postingdate"]))
