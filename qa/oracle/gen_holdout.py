#!/usr/bin/env python3
"""
Hold-out adversarial dataset generator (S0). Written BEFORE any new-engine code exists, seed frozen.

Purpose: catch engine over-fitting to ERP_Dump. Deliberately DIFFERENT from ERP_Dump in headers, name patterns,
cities, id formats (zero-padded SAP vendor numbers), date encodings (real Excel date cells + SAP DD.MM.YYYY text) and
in the kinds of traps. Emits (1) the workbook, (2) a PLANTED-STRUCTURE file (generator truth), and later the
independent oracle derives its own truth from the data alone; the two are cross-checked.
"""
import argparse, json, random, string, datetime as dt
import openpyxl
from openpyxl.styles import numbers

ap = argparse.ArgumentParser()
ap.add_argument("--seed", type=int, default=7919)
ap.add_argument("--out", default="qa/fixtures/holdout_master_entity.xlsx")
ap.add_argument("--plant", default="qa/oracle/truth/holdout.plant.json")
a = ap.parse_args()
R = random.Random(a.seed)
REF = dt.date(2026, 9, 24)

PRE = ["Sri", "Shree", "Mahalaxmi", "Balaji", "Gopal", "Annapurna", "Kalinga", "Utkal", "Deccan", "Malabar", "Konkan", "Vindhya", "Himalayan", "Nilgiri", "Coromandel", "Sahyadri", "Godavari", "Krishna"]
COR = ["Steel", "Engineering", "Polymers", "Castings", "Fasteners", "Electricals", "Hydraulics", "Logistics", "Packaging", "Abrasives", "Bearings", "Tools", "Rubber", "Cables"]
SUF = ["Works", "Traders", "Industries", "Enterprises", "Corporation", "Solutions", "Agencies", "Associates"]
LEG = ["Pvt Ltd", "Private Limited", "Pvt. Ltd.", "Ltd", "LLP", ""]
TOWNS = [("Ahmedabad", "Gujarat", "38"), ("Coimbatore", "Tamil Nadu", "64"), ("Kochi", "Kerala", "68"), ("Jaipur", "Rajasthan", "30"), ("Lucknow", "Uttar Pradesh", "22"),
         ("Nagpur", "Maharashtra", "44"), ("Visakhapatnam", "Andhra Pradesh", "53"), ("Indore", "Madhya Pradesh", "45"), ("Surat", "Gujarat", "39"), ("Ludhiana", "Punjab", "14"),
         ("Raipur", "Chhattisgarh", "49"), ("Ranchi", "Jharkhand", "83"), ("Guwahati", "Assam", "78"), ("Mysuru", "Karnataka", "57"), ("Madurai", "Tamil Nadu", "62"),
         ("Nashik", "Maharashtra", "42"), ("Rajkot", "Gujarat", "36"), ("Bhopal", "Madhya Pradesh", "46"), ("Patna", "Bihar", "80"), ("Vadodara", "Gujarat", "39")]
ESTATES = ["MIDC Phase 2", "GIDC Estate", "SIPCOT Industrial Park", "Sector 5 Industrial Area", "Focal Point Ext", "Industrial Growth Centre", "Udyog Nagar", "Export Promotion Zone"]
ITEMS = [("M-1000", "MS Plate 6MM"), ("M-1001", "MS Plate 8MM"), ("M-1002", "Ball Bearing 6203"), ("M-1003", "Ball Bearing 6204"), ("M-1004", "Copper Wire 2.5 SQMM"),
         ("M-1005", "Hydraulic Hose 1/2 Inch"), ("M-1006", "Welding Rod 3.15MM"), ("M-1007", "Safety Gloves Large"), ("M-1008", "Cutting Oil 20L"), ("M-1009", "Hex Bolt M12X50"),
         ("M-1010", "Hex Bolt M12X60"), ("M-1011", "PVC Pipe 110MM"), ("M-1012", "Gasket Kit A1"), ("M-1013", "Gasket Kit A2"), ("M-1014", "Angle Iron 50X50X5"),
         ("M-1015", "Angle Iron 40X40X5"), ("M-1016", "Drill Bit 10MM"), ("M-1017", "Drill Bit 12MM"), ("M-1018", "V Belt B-52"), ("M-1019", "V Belt B-54")]
UOM = {"M-1004": "MTR", "M-1008": "LTR", "M-1005": "MTR"}
COLS = ["S.No", "Supplier No.", "Supplier Name", "GST No", "Party Type", "Material No.", "Material Desc.", "Base UoM", "Order Qty", "Net Price", "Tax %",
        "E-mail", "Mobile", "Street Address", "Town", "Region", "PIN Code", "Created On", "Changed On", "Terms of Payment", "Curr."]

def gstin(used):
    while True:
        g = f"{R.randint(1, 37):02d}" + "".join(R.choices(string.ascii_uppercase, k=5)) + f"{R.randint(0, 9999):04d}" + R.choice(string.ascii_uppercase) + R.choice("123456789ABCDEFGHJKLMNPQRSTUVWXYZ") + "Z" + R.choice("0123456789ABCDEFGHJKLMNPQRSTUVWXYZ")
        if g not in used: used.add(g); return g

def slug(s): return "".join(c for c in s.lower() if c.isalnum())

used_g, used_names, used_vc, uid = set(), set(), set(), [0]
def new_entity(estate_pool=None):
    while True:
        base = f"{R.choice(PRE)} {R.choice(COR)} {R.choice(SUF)}"
        if base not in used_names: used_names.add(base); break
    uid[0] += 1; k = uid[0]
    while True:
        vc = f"{R.randint(100000, 999999):010d}"
        if vc not in used_vc: used_vc.add(vc); break
    town, region, pin2 = R.choice(TOWNS)
    if estate_pool is not None: street = estate_pool
    else: street = f"Plot {R.randint(1, 400)}, {R.choice(ESTATES)}"
    it = R.choice(ITEMS)
    cd = REF - dt.timedelta(days=R.randint(150, 1800)); md = cd + dt.timedelta(days=R.randint(0, 400))
    md = min(md, REF - dt.timedelta(days=20))
    return dict(uid=k, name=f"{base} {R.choice(LEG)}".strip(), root=base, gstin=gstin(used_g), vc=vc, ptype=R.choice(["Vendor", "Customer", "Both"]),
                item=it[0], desc=it[1], uom=UOM.get(it[0], "PCS"), qty=R.randint(1, 500), price=round(R.uniform(10, 5000), 2), tax=R.choice([5, 12, 18, 28]),
                email=f"accounts{k}@{slug(base)}.co.in", phone=str(9000000000 + 7919 * k % 999999999 + k), addr=f"{street}, {town}", town=town, region=region,
                pin=f"{pin2}{R.randint(1000, 9999)}", created=cd, modified=md, terms=R.choice(["Net 30", "Net 45", "Net 60"]), cur="INR")

def emit(e): return dict(e)  # a copy
E = [new_entity() for _ in range(560)]
# shared-estate decoys: 60 different entities sharing ~12 identical street strings
shared = [f"Plot {R.randint(1, 60)}, {R.choice(ESTATES)}" for _ in range(12)]
for _ in range(60):
    e = new_entity(estate_pool=R.choice(shared)); E.append(e)
base_pool = iter(R.sample(E, len(E)))
def take(): return next(base_pool)

rows, plant = [], dict(exact=[], normalized=[], fuzzy_typo=[], two_vendor_codes=[], fuzzy_candidate=[], fuzzy_decoy=[], gst_conflict=[], reverse_gst=[],
                       vendor_code_identity=[], invalid_gstin_dup=[], missing_name_dup=[], vc_zero_pad=[], shared_phone_decoy=[], missing=[], invalid=[], temporal=[],
                       stale=[], future=[], item_conflict=[], item_equivalent_decoy=[])
def add(e, tag=None):
    r = emit(e); r["_tag"] = tag; rows.append(r); return r
def transpose(s):
    i = R.randrange(2, len(s) - 3); return s[:i] + s[i + 1] + s[i] + s[i + 2:]
def variant_changed(name):
    for kind in R.sample(["case", "space", "legal", "ms", "and"], 5):
        v = variant(name, kind)
        if v != name: return v
    return name.upper()
def variant(name, kind):
    if kind == "case": return name.upper()
    if kind == "space": return name.replace(" ", "  ")
    if kind == "legal": return name.replace("Pvt Ltd", "Private Limited").replace("Pvt. Ltd.", "Pvt Ltd") + ("" if any(x in name for x in ("Pvt", "Ltd", "LLP", "Private")) else " Pvt Ltd")
    if kind == "ms": return "M/s " + name
    if kind == "and": return name.replace("Engineering", "Engg").replace("Enterprises", "Enterprises")
    return name

used_ids = set()
def mark(*ents): used_ids.update(e["uid"] for e in ents)
originals = {}
for e in E: originals[e["uid"]] = e
def base_row(e, tag=None): return add(e, tag)

# ---- plant duplicates (each base is a distinct entity; both base row and copy are emitted) ----
def dup_group(n, tagname, mut):
    for _ in range(n):
        b = take(); r0 = base_row(b, f"{tagname}:base"); c = emit(b); mut(c, b); r1 = add(c, f"{tagname}:copy")
        plant[tagname].append([b["uid"], id(r1)]); r0["_pair"] = r1["_pair"] = (tagname, len(plant[tagname]) - 1); mark(b)
        plant[tagname][-1] = [id(r0), id(r1)]
dup_group(25, "exact", lambda c, b: None)
def m_norm(c, b): c["name"] = variant_changed(b["name"])
dup_group(30, "normalized", m_norm)
def m_typo(c, b): c["name"] = b["name"].replace(b["root"], transpose(b["root"]), 1)   # typo inside the root, never across the legal suffix
dup_group(15, "fuzzy_typo", m_typo)
def m_two(c, b):
    while True:
        v = f"{R.randint(100000, 999999):010d}"
        if v not in used_vc: used_vc.add(v); break
    c["vc"] = v
dup_group(15, "two_vendor_codes", m_two)
def m_fc(c, b): c["gstin"] = None; c["vc"] = None; c["name"] = variant(b["name"], R.choice(["case", "legal", "space"]))
dup_group(12, "fuzzy_candidate", m_fc)
def m_fd(c, b): c["gstin"] = None; c["vc"] = None; c["name"] = variant(b["name"], "case"); c["email"] = f"info{c['uid']}x@{slug(b['root'])}.in"; c["addr"] = f"Plot {R.randint(401, 900)}, {R.choice(ESTATES)}, {b['town']}"
dup_group(8, "fuzzy_decoy", m_fd)   # same phone only -> ONE strong signal -> must NOT be a candidate
def m_ig(c, b): c["gstin"] = R.choice([c["gstin"][:11], c["gstin"][:14] + "@", "XX" + c["gstin"][2:]])
dup_group(8, "invalid_gstin_dup", m_ig)
def m_mn(c, b): c["name"] = None
dup_group(6, "missing_name_dup", m_mn)
def m_zp(c, b): c["vc"] = c["vc"].lstrip("0")
dup_group(6, "vc_zero_pad", m_zp)
# ---- conflicts ----
for _ in range(12):
    b = take(); r0 = base_row(b, "gst_conflict:a"); c = new_entity(); c["gstin"] = b["gstin"]
    if _ % 2 == 0: c["email"], c["phone"] = b["email"], b["phone"]
    r1 = add(c, "gst_conflict:b"); plant["gst_conflict"].append([id(r0), id(r1)]); mark(b, c)
for _ in range(8):
    b = take(); r0 = base_row(b, "reverse_gst:a"); c = emit(b); c["gstin"] = gstin(used_g); r1 = add(c, "reverse_gst:b"); plant["reverse_gst"].append([id(r0), id(r1)]); mark(b)
for _ in range(6):
    b = take(); b["gstin"] = None; r0 = base_row(b, "vendor_code_identity:a"); c = new_entity(); c["gstin"] = None; c["vc"] = b["vc"]
    r1 = add(c, "vendor_code_identity:b"); plant["vendor_code_identity"].append([id(r0), id(r1)]); mark(b, c)
for _ in range(10):   # switchboard decoys: same phone only, different companies, distinct hard ids
    b = take(); r0 = base_row(b, "shared_phone:a"); c = new_entity(); c["phone"] = b["phone"]; r1 = add(c, "shared_phone:b"); plant["shared_phone_decoy"].append([id(r0), id(r1)]); mark(b, c)
# ---- remaining originals as plain rows ----
for e in E:
    if e["uid"] not in used_ids and not any(r["uid"] == e["uid"] for r in rows if r["_tag"] in (None,)):
        pass
seen_uids = {r["uid"] for r in rows}
plain = [e for e in E if e["uid"] not in seen_uids]
for e in plain: add(e, None)
plain_rows = [r for r in rows if r["_tag"] is None]
# ---- data-quality plants on plain rows ----
pool = list(plain_rows); R.shuffle(pool)
def pick(n): return [pool.pop() for _ in range(n)]
for r in pick(12):
    f = R.choice(["email", "phone", "addr", "town", "created", "gstin_blank"]); r["_tag"] = "missing:" + f
    if f == "gstin_blank": r["gstin"] = None
    else: r[f] = None
    plant["missing"].append(id(r))
for r in pick(20):
    k = R.choice(["email", "phone", "pin", "qty", "price", "tax", "gstin", "changed_text"]); r["_tag"] = "invalid:" + k
    if k == "email": r["email"] = "not-an-email"
    elif k == "phone": r["phone"] = "98765"
    elif k == "pin": r["pin"] = "ABC123"
    elif k == "qty": r["qty"] = -R.randint(1, 50)
    elif k == "price": r["price"] = -999
    elif k == "tax": r["tax"] = 180
    elif k == "gstin": r["gstin"] = r["gstin"][:10]
    else: r["modified_text"] = R.choice(["31.02.2024", "N/A", "00.00.0000"])
    plant["invalid"].append(id(r))
for r in pick(6):
    r["_tag"] = "temporal"; r["modified"] = r["created"] - dt.timedelta(days=R.randint(5, 120)); plant["temporal"].append(id(r))
for r in pick(15):
    r["_tag"] = "stale"; r["created"] = dt.date(R.randint(2014, 2016), R.randint(1, 12), R.randint(1, 28)); r["modified"] = r["created"] + dt.timedelta(days=R.randint(30, 300)); plant["stale"].append(id(r))
for r in pick(4):
    r["_tag"] = "future"; r["created"] = REF + dt.timedelta(days=R.randint(30, 300)); r["modified"] = r["created"] + dt.timedelta(days=5); plant["future"].append(id(r))
# ---- item-code consistency plants (on remaining plain rows) ----
pool = [r for r in plain_rows if r["_tag"] is None]; R.shuffle(pool)
conf_codes = R.sample([c for c, _ in ITEMS], 8)
for code in conf_codes:
    r = pool.pop(); other = R.choice([d for c, d in ITEMS if c != code]); r["item"] = code; r["desc"] = other; r["_tag"] = "item_conflict"; plant["item_conflict"].append([code, id(r)])
eq_codes = [c for c in R.sample([c for c, _ in ITEMS if c not in conf_codes], 10)]
for code in eq_codes:
    r = pool.pop(); canon = dict(ITEMS)[code]; r["item"] = code
    r["desc"] = R.choice([canon.upper(), canon.replace("MM", " MM"), canon.replace("  ", " ") + " ", canon.lower()]) ; r["_tag"] = "item_equiv"; plant["item_equivalent_decoy"].append([code, id(r)])
# near-miss: numeric token differs (6MM vs 8MM) -> real conflict
for code in ["M-1000", "M-1009"]:
    if code in conf_codes: continue
    r = pool.pop(); r["item"] = code; r["desc"] = dict(ITEMS)[code].replace("6MM", "9MM").replace("M12X50", "M12X55"); r["_tag"] = "item_conflict"; plant["item_conflict"].append([code, id(r)])
# ---- shuffle rows, assign S.No, write workbook ----
R.shuffle(rows)
for i, r in enumerate(rows, 1): r["sno"] = i
idmap = {id(r): r["sno"] for r in rows}
wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Vendor_Master"; ws.append(COLS)
for r in rows:
    mod = r.get("modified_text") or r["modified"].strftime("%d.%m.%Y")
    ws.append([r["sno"], r["vc"], r["name"], r["gstin"], r["ptype"], r["item"], r["desc"], r["uom"], r["qty"], r["price"], r["tax"], r["email"], r["phone"], r["addr"], r["town"], r["region"], r["pin"], r["created"], mod, r["terms"], r["cur"]])
    if r["created"] is not None: ws.cell(ws.max_row, 18).number_format = "DD.MM.YYYY"
    ws.cell(ws.max_row, 2).number_format = "@"
wb.create_sheet("README").append(["Hold-out adversarial dataset; generator seed", a.seed])
wb.save(a.out)
def conv(v):
    if isinstance(v, list): return [conv(x) for x in v]
    return idmap[v] if isinstance(v, int) and v in idmap else v
out = {k: [([x[0], idmap[x[1]]] if k in ("item_conflict", "item_equivalent_decoy") else conv(x)) for x in v] if k in ("item_conflict", "item_equivalent_decoy") else [conv(x) for x in v] for k, v in plant.items()}
out["meta"] = dict(seed=a.seed, rows=len(rows), note="PLANTED structure (generator truth). S.No is the row id.")
json.dump(out, open(a.plant, "w"), indent=1)
print("rows", len(rows), {k: len(v) for k, v in out.items() if k != "meta"})
