#!/usr/bin/env python3
"""Validates the ORACLE (not the engine) against the ERP_Dump generator's block layout, which was reverse-engineered
from the file in the audit: ERP-00211..310 are mutated copies of base rows. TEST-FILE-SPECIFIC; never imported by the engine."""
import json, sys
t = json.load(open("oracle/truth/erp_dump.truth.json"))
fmt = lambda n: f"ERP-{n:05d}"
plant = {}   # copy -> (base, category)
for k, b in enumerate(range(1, 40, 2)): plant[fmt(211 + k)] = (fmt(b), "exact")
for k in range(15): plant[fmt(231 + k)] = (fmt(21 + k), "normalized")
for k in range(10): plant[fmt(246 + k)] = (fmt(41 + k), "fuzzy_block")
for k in range(10): plant[fmt(266 + k)] = (fmt(81 + k), "item_conflict")
for k in range(10): plant[fmt(276 + k)] = (fmt(101 + k), "missing")
for k in range(10): plant[fmt(286 + k)] = (fmt(121 + k), "invalid")
for k in range(10): plant[fmt(296 + k)] = (fmt(141 + k), "stale")
for k in range(5):  plant[fmt(306 + k)] = (fmt(156 + k), "temporal")
gst = {frozenset((fmt(256 + k), fmt(61 + k))) for k in range(10)}
# expected clusters from structure = connected components of (copy, base) edges
par = {}
def f(x):
    par.setdefault(x, x)
    while par[x] != x: par[x] = par[par[x]]; x = par[x]
    return x
for c, (b, _) in plant.items(): par[f(c)] = f(b)
comp = {}
for x in list(par): comp.setdefault(f(x), set()).add(x)
exp = {frozenset(v) for v in comp.values() if len(v) > 1}
got = {frozenset(c["members"]) for c in t["entity_clusters"]}
print("structure clusters:", len(exp), "| oracle clusters:", len(got), "| identical sets:", exp == got)
print("only in structure:", sorted(map(sorted, exp - got))[:3], "| only in oracle:", sorted(map(sorted, got - exp))[:3])
gg = {frozenset(g["members"]) for g in t["conflict_groups"]}
print("GST conflict groups identical:", gg == gst)
ok = True
exp_missing = {fmt(276 + k) for k in range(10)}; ok &= set(t["missing"]["records"]) == exp_missing
exp_inv = {fmt(286 + k) for k in range(10)}; ok &= set(t["invalid"]["records"]) == exp_inv
exp_temp = {fmt(306 + k) for k in range(5)}; ok &= set(t["temporal"]["modified_before_created"]) == exp_temp
print("missing/invalid/temporal sets match structure:", ok)
print("item conflict groups:", len(t["item_conflicts"]), "minority == planted 266..275:", {r for g in t["item_conflicts"] for r in g["minority_records"]} == {fmt(266 + k) for k in range(10)})
st = [s for s in t["stale_table"] if s["threshold_years"] == 4 and s["reference_date"] == "2026-09-24"][0]
print("stale(4y, ref today) == planted 296..305:", set(st["records"]) == {fmt(296 + k) for k in range(10)})
sys.exit(0 if (exp == got and gg == gst and ok) else 1)
