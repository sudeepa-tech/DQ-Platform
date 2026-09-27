#!/usr/bin/env python3
"""
Independent QA oracle for master-entity data (Phase 1, S0).

INDEPENDENCE: shares NO code with the engine under test. Different language, different similarity metric
(difflib ratio, not the engine's Jaro-Winkler/Levenshtein blend), an explicit human-supplied column mapping
(never inferred), and index/brute-force pair enumeration.

SEMANTICS IMPLEMENTED (approved P0 plan + user decisions; every rule is data-agnostic, nothing names a test file):
  hard IDs        : valid-format GSTIN (legal identity), vendor code (entity identity). row_id is NEVER evidence.
  invalid values  : an INVALID hard ID is neither support nor conflict (it is a quality issue instead).
  name relation   : eq (normalized equal) | sim (ratio>=0.90 and equal numeric tokens) | different (ratio<0.60 or
                    numeric tokens differ) | ambiguous (0.60..0.90; excluded from scoring) | unknown (a name missing)
  DUPLICATE (a,b) : hard_agree AND no same-class hard conflict AND name in {eq,sim,unknown}
                    (unknown additionally needs a 2nd hard agreement or an equal phone/email)
  CONFLICT  (a,b) : gstin agree & name different & vendor code not agreeing   -> gstin_shared_identity
                    vendor code agree & both valid GSTIN differ                -> gstin_mismatch
                    vendor code agree & name different & gstin not agreeing    -> vendor_code_identity
                    gstin agree & vendor code agree & name different           -> identity_name_conflict
  NOTE            : same GSTIN + same name + DIFFERENT vendor codes is a DUPLICATE (classic 'one company, two vendor
                    codes'), not a conflict. Oracle semantic decision flagged for user confirmation.
  FUZZY CANDIDATE : no hard agreement, no hard conflict, name eq/sim with equal numeric tokens AND >=2 independent
                    strong signals among {phone equal, email equal, postal+address-core equal}. Never auto-clustered.
  dup_type        : exact_business_duplicate (all business fields equal EXCLUDING row_id) > normalized_duplicate
                    (only the name differs and is equal after normalization) > audit_date_variant (only
                    created/modified differ) > fuzzy_name_variant (name similar, other diffs) > attribute_variant.
  Clusters        : constrained union-find (a union that would join two different valid GSTINs is refused).
  Missing         : role-aware; 'expected' roles = mapped roles >=95% populated (heuristic, per user decision 5).
  Invalid         : gstin structure, email, phone(IN), postal(IN), quantity>=0, price>=0, tax 0..100, date parse.

CHANGELOG
  1.1  (S0, before any engine run on the hold-out) two defects found by cross-checking against the generator's plant:
       (a) 'M/s' company prefix was not stripped (common Indian convention)            -> stripped on the raw string
       (b) character-ratio alone called 'Kalinga Tools Agencies' vs 'Annapurna Electricals Agencies' ambiguous
           (0.615) because both end in 'Agencies'          -> 'different' if ratio<0.85 AND token-Jaccard<=0.34
           (first attempt without the ratio<0.85 clause misfired on space-swap typos, e.g. 'AbrasivesE nterprises')
       ERP_Dump truth verified unchanged by 1.1.
"""
import argparse, json, re, hashlib, itertools, difflib, datetime as dt
from collections import defaultdict, Counter
import pandas as pd

ORACLE_VERSION = "1.2"   # 1.2: adds match_class/match_subtype to duplicate pairs (approved decision 1). No existing field changed.
GSTIN_RE = re.compile(r"^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$")
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
LEGAL = {"pvt", "private", "ltd", "limited", "llp", "inc", "incorporated"}
ABBR = {"engg": "engineering", "mfg": "manufacturing", "co": "company", "corp": "corporation",
        "intl": "international", "ind": "industries"}
DROP = {"the"}


def blank(v):
    return v is None or (isinstance(v, float) and pd.isna(v)) or str(v).strip() == "" or str(v).strip().lower() == "nan"


def tokens(s):
    s = str(s).lower().replace("&", " and ")
    s = re.sub(r"(?<=[a-z0-9])\.(?=[a-z])", "", s)      # m.s. -> ms ; p.ltd -> pltd handled below
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return [t for t in s.split() if t]


def norm_name(s):
    if blank(s):
        return ""
    s = re.sub(r"^\s*m\s*/\s*s\.?\s+", "", str(s), flags=re.I)         # 'M/s' prefix
    t = [ABBR.get(x, x) for x in tokens(s)]
    if t and t[0] == "ms":
        t = t[1:]                                        # 'M/s' prefix
    t = [x for x in t if x not in LEGAL and x not in DROP]
    return " ".join(t)


def num_tokens(s):
    return sorted({(x.lstrip("0") or "0") for x in re.findall(r"\d+(?:\.\d+)?", s)})


def ratio(a, b):
    return difflib.SequenceMatcher(None, a, b).ratio()


def name_rel(a, b):
    if not a or not b:
        return "unknown", None
    if a == b:
        return "eq", 1.0
    r = ratio(a, b)
    if num_tokens(a) != num_tokens(b):
        return "different", r                            # numeric tokens are discriminators
    ta, tb = set(a.split()), set(b.split())
    if r < 0.85 and len(ta & tb) / len(ta | tb) <= 0.34:
        return "different", r                            # <=1 shared token in 3: shared suffix words must not fake similarity
    if r >= 0.90:
        return "sim", r
    if r < 0.60:
        return "different", r
    return "ambiguous", r


def norm_desc(s):
    if blank(s):
        return ""
    t = str(s).lower().replace("&", " and ")
    t = re.sub(r"(\d)\s*(mm|cm|m|kg|g|ml|l|hp|sqmm|mtr|inch|ft)\b", r"\1\2", t)
    t = re.sub(r"(?<=[a-z0-9])\.(?=[a-z])", "", t)
    t = re.sub(r"[^a-z0-9./ ]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return " ".join(ABBR.get(x, x) for x in t.split())


def desc_equiv(a, b):
    return a == b or (ratio(a, b) >= 0.92 and num_tokens(a) == num_tokens(b))


def phone_norm(v):
    if blank(v):
        return None, False
    d = re.sub(r"\D", "", str(v))
    if len(d) == 12 and d.startswith("91"):
        d = d[2:]
    if len(d) == 11 and d.startswith("0"):
        d = d[1:]
    ok = bool(re.fullmatch(r"[6-9]\d{9}", d))
    return (d if ok else None), ok


def addr_core(addr, city, state):
    if blank(addr):
        return ""
    t = re.sub(r"[^a-z0-9 ]", " ", str(addr).lower())
    drop = set(tokens(city) if not blank(city) else []) | set(tokens(state) if not blank(state) else [])
    return " ".join(x for x in t.split() if x not in drop)


def parse_date(v, fmts):
    if blank(v):
        return None, "missing"
    if isinstance(v, (dt.datetime, dt.date, pd.Timestamp)):
        return pd.Timestamp(v).strftime("%Y-%m-%d"), "ok"
    s = str(v).strip()
    for f in fmts:
        try:
            return dt.datetime.strptime(s, f).strftime("%Y-%m-%d"), "ok"
        except ValueError:
            pass
    return None, "unparseable"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--sheet")
    ap.add_argument("--mapping", required=True)
    ap.add_argument("--ref-date", default="2026-09-24")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    m = json.load(open(a.mapping))
    C = m["columns"]
    fmts = m.get("date_formats", ["%Y-%m-%d"])
    df = pd.read_excel(a.data, sheet_name=a.sheet, dtype=object) if a.data.endswith("xlsx") else pd.read_csv(a.data, dtype=str)
    df["__row"] = range(2, len(df) + 2)                  # Excel row number incl. header row
    n = len(df)
    col = lambda role: C.get(role)

    def get(r, role):
        return None if not col(role) or blank(r[col(role)]) else str(r[col(role)]).strip()

    recs = []
    for _, r in df.iterrows():
        rid = str(r[C["row_id"]]).strip()
        g = get(r, "gstin")
        gv = bool(g and GSTIN_RE.match(g.upper()))
        ph, phv = phone_norm(r[col("phone")]) if col("phone") else (None, False)
        em = get(r, "email")
        emv = bool(em and EMAIL_RE.match(em))
        vc = get(r, "vendor_code")
        vc = (vc.lstrip("0") if vc and vc.isdigit() else (vc.upper() if vc else None))
        cd, cs = parse_date(r[col("created")], fmts) if col("created") else (None, "missing")
        md, ms = parse_date(r[col("modified")], fmts) if col("modified") else (None, "missing")
        nm = get(r, "name")
        recs.append(dict(id=rid, row=int(r["__row"]), name=nm, nn=norm_name(nm), gstin=g.upper() if g else None, gstin_valid=gv,
                         vc=vc, phone=ph, phone_valid=phv, email=em.lower() if emv else None, email_valid=emv,
                         ac=addr_core(get(r, "address"), get(r, "city"), get(r, "state")), postal=get(r, "postal"),
                         created=cd, cstat=cs, modified=md, mstat=ms, raw=r))
    assert len({r["id"] for r in recs}) == n, "row_id not unique"

    idx = defaultdict(list)
    for i, r in enumerate(recs):
        if r["gstin_valid"]: idx[("g", r["gstin"])].append(i)
        if r["vc"]: idx[("v", r["vc"])].append(i)
        if r["phone"]: idx[("p", r["phone"])].append(i)
        if r["email"]: idx[("e", r["email"])].append(i)
        if r["ac"] and r["postal"]: idx[("a", r["postal"], r["ac"])].append(i)
    cand = set()
    for k, v in idx.items():
        if len(v) > 400:
            continue
        cand.update(itertools.combinations(sorted(v), 2))

    biz = [c for c in df.columns if c not in (C["row_id"], "__row")]

    def diff_fields(x, y):
        out = []
        for c in biz:
            p, q = x["raw"][c], y["raw"][c]
            pb, qb = blank(p), blank(q)
            if pb and qb: continue
            if pb != qb: out.append((c, "null_gap")); continue
            if str(p).strip() != str(q).strip(): out.append((c, "value"))
        return out

    dups, conflicts, ambiguous, fuzzy = [], [], [], []
    for i, j in sorted(cand):
        x, y = recs[i], recs[j]
        gs_agree = x["gstin_valid"] and y["gstin_valid"] and x["gstin"] == y["gstin"]
        gs_conf = x["gstin_valid"] and y["gstin_valid"] and x["gstin"] != y["gstin"]
        vc_agree = bool(x["vc"] and y["vc"] and x["vc"] == y["vc"])
        rel, r_ = name_rel(x["nn"], y["nn"])
        ph_eq = bool(x["phone"] and x["phone"] == y["phone"])
        em_eq = bool(x["email"] and x["email"] == y["email"])
        contact_eq = ph_eq or em_eq
        hard = gs_agree or vc_agree
        ev = [s for s, ok in [("gstin_agree", gs_agree), ("vendor_code_agree", vc_agree), ("phone_equal", ph_eq),
                              ("email_equal", em_eq), ("gstin_conflict", gs_conf)] if ok]
        base = dict(a=x["id"], b=y["id"], name_relation=rel, name_ratio=None if r_ is None else round(r_, 3), evidence=ev)
        ctype = None
        if gs_agree and vc_agree and rel == "different": ctype = "identity_name_conflict"
        elif gs_agree and rel == "different" and not vc_agree: ctype = "gstin_shared_identity"
        elif vc_agree and gs_conf: ctype = "gstin_mismatch"
        elif vc_agree and rel == "different" and not gs_agree: ctype = "vendor_code_identity"
        if ctype:
            conflicts.append(dict(base, conflict_type=ctype)); continue
        if hard and not gs_conf:
            if rel in ("eq", "sim") or (rel == "unknown" and ((gs_agree and vc_agree) or contact_eq)):
                d = diff_fields(x, y)
                names = {f for f, _ in d}
                if not d: t = "exact_business_duplicate"
                elif names <= {C["name"]} and x["nn"] == y["nn"]: t = "normalized_duplicate"
                elif names <= {c for c in (col("created"), col("modified")) if c}: t = "audit_date_variant"
                elif rel == "sim": t = "fuzzy_name_variant"
                else: t = "attribute_variant"
                # approved decision 1: same GSTIN + same/compatible name + DIFFERENT vendor codes = same business entity (an ENTITY MATCH
                # with subtype identity_match_vendor_code_variant), never a hard identity conflict. dup_type is left exactly as before.
                vc_differs = bool(x["vc"] and y["vc"] and x["vc"] != y["vc"])
                mclass, msub = t, None
                if gs_agree and vc_differs and rel in ("eq", "sim"): mclass, msub = "entity_match", "identity_match_vendor_code_variant"
                dups.append(dict(base, dup_type=t, match_class=mclass, match_subtype=msub, diff_fields=[dict(field=f, kind=k) for f, k in d]))
            elif rel == "ambiguous":
                ambiguous.append(base)
            continue
        if not hard and not gs_conf and rel in ("eq", "sim"):
            strong = sum(1 for ok in [ph_eq, em_eq, bool(x["ac"] and x["ac"] == y["ac"] and x["postal"] == y["postal"])] if ok)
            if strong >= 2:
                fuzzy.append(dict(base, strong_signals=strong))

    classified = {(d["a"], d["b"]) for d in dups + conflicts + fuzzy + ambiguous}
    shared_contact = [dict(a=recs[i]["id"], b=recs[j]["id"]) for i, j in sorted(cand)
                      if (recs[i]["id"], recs[j]["id"]) not in classified and
                      ((recs[i]["phone"] and recs[i]["phone"] == recs[j]["phone"]) or (recs[i]["email"] and recs[i]["email"] == recs[j]["email"]))]

    parent = {r["id"]: r["id"] for r in recs}
    gset = {r["id"]: ({r["gstin"]} if r["gstin_valid"] else set()) for r in recs}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x

    refused = 0
    strength = lambda d: ("gstin_agree" in d["evidence"]) + ("vendor_code_agree" in d["evidence"])
    for d in sorted(dups, key=lambda d: -strength(d)):
        ra, rb = find(d["a"]), find(d["b"])
        if ra == rb: continue
        if gset[ra] and gset[rb] and gset[ra] != gset[rb]:
            refused += 1; continue
        parent[ra] = rb; gset[rb] |= gset[ra]
    comp = defaultdict(list)
    for r in recs: comp[find(r["id"])].append(r["id"])
    clusters = []
    for k, mem in sorted(comp.items(), key=lambda kv: sorted(kv[1])[0]):
        if len(mem) < 2: continue
        mem = sorted(mem); ms_ = set(mem)
        pr = [d for d in dups if d["a"] in ms_ and d["b"] in ms_]
        clusters.append(dict(id=f"C{len(clusters)+1:03d}", members=mem, pairs=pr, dup_types=dict(Counter(p["dup_type"] for p in pr))))

    cg = {}
    for c in conflicts:
        key = (c["conflict_type"], tuple(sorted([c["a"], c["b"]])))
        cg.setdefault(key, dict(type=c["conflict_type"], members=sorted([c["a"], c["b"]]), evidence=c["evidence"], name_relation=c["name_relation"]))

    item_conf = []
    if col("item_code") and col("item_desc"):
        groups = defaultdict(list)
        for r in recs:
            cv, dv = r["raw"][col("item_code")], r["raw"][col("item_desc")]
            if blank(cv) or blank(dv): continue
            groups[str(cv).strip().upper()].append((r["id"], norm_desc(dv)))
        for code, lst in sorted(groups.items()):
            classes = []
            for rid, ds in lst:
                for c in classes:
                    if desc_equiv(c["rep"], ds): c["records"].append(rid); break
                else:
                    classes.append(dict(rep=ds, records=[rid]))
            if len(classes) > 1:
                classes.sort(key=lambda c: (-len(c["records"]), c["rep"]))
                tie = len(classes[0]["records"]) == len(classes[1]["records"])
                item_conf.append(dict(code=code, tie=tie,
                                      classes=[dict(description=c["rep"], count=len(c["records"]), records=sorted(c["records"])) for c in classes],
                                      minority_records=sorted(r for c in classes[1:] for r in c["records"])))

    roles = [k for k in C if k != "row_id"]
    ratio_pop = {role: float(sum(0 if blank(v) else 1 for v in df[C[role]]) / n) for role in roles}
    expected = [r_ for r_ in roles if ratio_pop[r_] >= 0.95]
    missing = {}
    for r in recs:
        f = [C[role] for role in expected if blank(r["raw"][C[role]])]
        if f: missing[r["id"]] = f

    inv = defaultdict(list)

    def num(v):
        try: return float(str(v).replace(",", ""))
        except Exception: return None

    for r in recs:
        raw = r["raw"]
        if r["gstin"] and not r["gstin_valid"]: inv[r["id"]].append(dict(rule="gstin_structure", field=C["gstin"], value=r["gstin"]))
        if col("email") and not blank(raw[C["email"]]) and not r["email_valid"]: inv[r["id"]].append(dict(rule="email_format", field=C["email"], value=str(raw[C["email"]])))
        if col("phone") and not blank(raw[C["phone"]]) and not r["phone_valid"]: inv[r["id"]].append(dict(rule="phone_format_in", field=C["phone"], value=str(raw[C["phone"]])))
        if col("postal") and not blank(raw[C["postal"]]) and not re.fullmatch(r"[1-9]\d{5}", str(raw[C["postal"]]).strip()):
            inv[r["id"]].append(dict(rule="postal_format_in", field=C["postal"], value=str(raw[C["postal"]])))
        for role, rule, lo, hi in [("quantity", "quantity_range", 0, None), ("unit_price", "price_range", 0, None), ("tax_rate", "tax_rate_range", 0, 100)]:
            if col(role) and not blank(raw[C[role]]):
                v = num(raw[C[role]])
                if v is None or v < lo or (hi is not None and v > hi):
                    inv[r["id"]].append(dict(rule=rule, field=C[role], value=str(raw[C[role]])))
        for role, st in (("created", r["cstat"]), ("modified", r["mstat"])):
            if col(role) and st == "unparseable":
                inv[r["id"]].append(dict(rule="date_parse", field=C[role], value=str(raw[C[role]])))

    temporal = [r["id"] for r in recs if r["created"] and r["modified"] and r["modified"] < r["created"]]
    ref = a.ref_date
    fut_c = [r["id"] for r in recs if r["created"] and r["created"] > ref]
    fut_m = [r["id"] for r in recs if r["modified"] and r["modified"] > ref]
    mods = [r["modified"] for r in recs if r["modified"]]
    maxmod = max(mods) if mods else None
    stale_table = []
    for refd in sorted({ref, maxmod} - {None}):
        for yrs in (1, 2, 3, 4, 5):
            days = yrs * 365.25
            rd = dt.date.fromisoformat(refd)
            ids = sorted(r["id"] for r in recs if r["modified"] and (rd - dt.date.fromisoformat(r["modified"])).days > days)
            stale_table.append(dict(reference_date=refd, threshold_years=yrs, threshold_days=days, count=len(ids), records=ids))

    out = dict(
        meta=dict(oracle_version=ORACLE_VERSION, data=a.data.split("/")[-1], sheet=a.sheet, n_records=n, ref_date=ref, mapping=m,
                  semantics_sha256=hashlib.sha256(open(__file__, "rb").read()).hexdigest()),
        records={r["id"]: dict(sheet_row=r["row"], created=r["created"], modified=r["modified"], name=r["name"]) for r in recs},
        entity_clusters=clusters, refused_unions=refused, conflict_groups=list(cg.values()), fuzzy_candidates=fuzzy,
        ambiguous_pairs=ambiguous, shared_contact_observations=shared_contact, item_conflicts=item_conf,
        missing=dict(expected_roles=expected, populated_ratio=ratio_pop, records=missing),
        invalid=dict(records=inv), temporal=dict(modified_before_created=temporal, future_created=fut_c, future_modified=fut_m),
        stale_table=stale_table)
    cl_recs = {x for c in clusters for x in c["members"]}
    out["summary"] = dict(
        entity_clusters=len(clusters), records_in_clusters=len(cl_recs), redundant_records=len(cl_recs) - len(clusters),
        cluster_sizes=dict(Counter(len(c["members"]) for c in clusters)),
        pair_dup_types=dict(Counter(p["dup_type"] for c in clusters for p in c["pairs"])),
        conflict_groups=dict(Counter(c["type"] for c in cg.values())), fuzzy_candidates=len(fuzzy), ambiguous_pairs=len(ambiguous),
        shared_contact_observations=len(shared_contact), item_conflict_groups=len(item_conf),
        item_conflict_minority_records=len({r for g in item_conf for r in g["minority_records"]}),
        missing_records=len(missing), invalid_records=len(inv), temporal=len(temporal), future=len(fut_c) + len(fut_m),
        refused_unions=refused)
    json.dump(out, open(a.out, "w"), indent=1, default=str)
    print(json.dumps(out["summary"], indent=1))


if __name__ == "__main__":
    main()
