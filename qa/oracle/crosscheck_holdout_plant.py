#!/usr/bin/env python3
"""Compares the ORACLE's derived truth with the GENERATOR's planted structure on the hold-out. Every disagreement is
listed and must be explained as either an oracle defect or a generator label defect. Never imported by the engine."""
import json, sys
T = json.load(open("oracle/truth/holdout.truth.json")); P = json.load(open("oracle/truth/holdout.plant.json"))
S = lambda n: str(n)
plant_dup_groups = ["exact", "normalized", "fuzzy_typo", "two_vendor_codes", "invalid_gstin_dup", "missing_name_dup", "vc_zero_pad"]
plant_pairs = {frozenset(map(S, p)): g for g in plant_dup_groups for p in P[g]}
orc_pairs = {frozenset([c_["a"], c_["b"]]): c_ for c in T["entity_clusters"] for c_ in c["pairs"]}
print("planted dup pairs:", len(plant_pairs), "| oracle dup pairs:", len(orc_pairs))
miss = [(sorted(k), g) for k, g in plant_pairs.items() if k not in orc_pairs]
extra = [sorted(k) for k in orc_pairs if k not in plant_pairs]
print("planted but NOT in oracle:", miss); print("in oracle but not planted:", extra[:10])
rows = {}
import openpyxl
ws = openpyxl.load_workbook("fixtures/holdout_master_entity.xlsx").worksheets[0]
hdr = [c.value for c in ws[1]]
for r in ws.iter_rows(min_row=2, values_only=True): rows[str(r[0])] = dict(zip(hdr, r))
for k, g in miss:
    print("  ", g, [(x, rows[x]["Supplier Name"], rows[x]["Supplier No."], rows[x]["GST No"]) for x in k])
# label-vs-actual for dup types
from collections import Counter
lab = Counter(); 
for k, g in plant_pairs.items():
    if k in orc_pairs: lab[(g, orc_pairs[k]["dup_type"])] += 1
print("planted label -> oracle dup_type:"); [print("  ", k, v) for k, v in sorted(lab.items())]
cf_plant = {"gst_conflict": "gstin_shared_identity", "reverse_gst": "gstin_mismatch", "vendor_code_identity": "vendor_code_identity"}
og = {frozenset(g["members"]): g["type"] for g in T["conflict_groups"]}
for g, t in cf_plant.items():
    pl = {frozenset(map(S, p)) for p in P[g]}
    ok = {k for k in pl if og.get(k) == t}
    print(f"conflict {g}: planted {len(pl)} oracle-agree {len(ok)}", [ (sorted(k), og.get(k)) for k in pl - ok])
fc = {frozenset([f["a"], f["b"]]) for f in T["fuzzy_candidates"]}; pf = {frozenset(map(S, p)) for p in P["fuzzy_candidate"]}
print("fuzzy candidates: planted", len(pf), "oracle", len(fc), "equal:", fc == pf, "| decoys wrongly candidate:", len(fc & {frozenset(map(S, p)) for p in P["fuzzy_decoy"]}))
print("ambiguous pairs:", [(a["a"], a["b"], a["name_ratio"], rows[a["a"]]["Supplier Name"], "|", rows[a["b"]]["Supplier Name"]) for a in T["ambiguous_pairs"]])
ic = {g["code"] for g in T["item_conflicts"]}; pc = {c for c, _ in P["item_conflict"]}
print("item conflict codes: oracle", len(ic), "planted", len(pc), "equal:", ic == pc, "| eq-decoy codes wrongly conflicting:", sorted(ic & {c for c, _ in P["item_equivalent_decoy"]} - pc))
print("temporal equal:", set(T["temporal"]["modified_before_created"]) == set(map(S, P["temporal"])))
print("future ⊇ planted:", set(map(S, P["future"])) <= set(T["temporal"]["future_created"]))
exp_inv = set(map(S, P["invalid"])) | {S(p[1]) for p in P["invalid_gstin_dup"]}; print("oracle invalid == planted invalid + malformed-GSTIN copies:", set(T["invalid"]["records"]) == exp_inv, "| diff:", sorted(set(T["invalid"]["records"]) ^ exp_inv))
