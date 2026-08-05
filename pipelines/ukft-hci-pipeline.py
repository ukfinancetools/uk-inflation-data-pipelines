#!/usr/bin/env python3
"""UKFT RCOL - HCI (Household Costs Indices) ingest pipeline.
HCI is spreadsheet-only (NOT in the ONS API). This resolves the latest quarterly
xlsx from the ONS reference-tables page, parses the 12-month %-change series for
each household group (all households, income deciles, tenure, retirement, children),
and writes ukft-hci-data.json for the RCOL 'Your Household' layer.
Quarterly cadence (HCI releases ~quarterly). Mirrors ukft-inflation-pipeline.js."""
import sys, os, re, json, io, datetime, urllib.request, urllib.error
import openpyxl

UA = {'User-Agent': 'curl/8.5.0', 'Accept': '*/*'}
LANDING = "https://www.ons.gov.uk/economy/inflationandpriceindices/datasets/householdcostsindicesforukhouseholdgroupsreferencetables"
FALLBACK_XLSX = "https://www.ons.gov.uk/file?uri=/economy/inflationandpriceindices/datasets/householdcostsindicesforukhouseholdgroupsreferencetables/januarytomarch2026/householdcostsindicesforukhouseholdgroupsjantomar2026.xlsx"
START_CAP = (2022, 1)  # All Households series starts Jan-2022; cap all groups to this common window
MON = {1:'JAN',2:'FEB',3:'MAR',4:'APR',5:'MAY',6:'JUN',7:'JUL',8:'AUG',9:'SEP',10:'OCT',11:'NOV',12:'DEC'}

TABLES = [
  {"sheet":"Table 1","mode":"direct","map":{
      "All Households":("all","All households","baseline"),
      "Income Decile 1":("decile1","Income decile 1 (lowest)","income"),
      "Income Decile 2":("decile2","Income decile 2","income"),
      "Income Decile 5":("decile5","Income decile 5 (middle)","income"),
      "Income Decile 9":("decile9","Income decile 9","income"),
      "Income Decile 10":("decile10","Income decile 10 (highest)","income")}},
  {"sheet":"Table 8","mode":"coicop","map":{
      "Mortgagor and other owner occupier":("mortgagor","Mortgaged / owner occupier","tenure"),
      "Outright owner occupier":("outright","Outright owner","tenure"),
      "Private renter":("private_renter","Private renter","tenure"),
      "Social and other renter":("social_renter","Social renter","tenure")}},
  {"sheet":"Table 13","mode":"coicop","map":{
      "Non-Retired":("non_retired","Non-retired household","retirement"),
      "Retired":("retired","Retired household","retirement")}},
  {"sheet":"Table 18","mode":"coicop","map":{
      "With Children":("with_children","With children","children"),
      "Without Children":("without_children","Without children","children")}},
]
MONTH_RE = re.compile(r'^([A-Z][a-z]{2})-(\d{4})')

def resolve_url():
    try:
        html = urllib.request.urlopen(urllib.request.Request(LANDING, headers=UA), timeout=25).read().decode('utf-8','replace')
        hrefs = re.findall(r'(/file\?uri=[^"\']*householdcosts[^"\']*\.xlsx)', html)
        hrefs = [h for h in hrefs if '/current/' not in h]  # /current/ alias 404s on the /file endpoint
        if hrefs:
            return "https://www.ons.gov.uk"+hrefs[0]  # first dated edition = latest
    except Exception as e:
        print(f"  WARN url-resolve failed ({e}); using fallback")
    return FALLBACK_XLSX

def parse_month(label):
    m = MONTH_RE.match(str(label).strip())
    if not m: return None
    mon3 = m.group(1).upper(); yr = int(m.group(2))
    monnum = {v:k for k,v in MON.items()}[mon3]
    return (yr, monnum, f"{yr} {mon3}")

def hdr_row(ws_rows):
    for i,r in enumerate(ws_rows):
        if r and str(r[0]).strip()=="Description:": return i
    raise ValueError("no Description: header")

def parse(xlsx_bytes):
    wb = openpyxl.load_workbook(io.BytesIO(xlsx_bytes), data_only=True, read_only=True)
    groups = {}
    for tcfg in TABLES:
        ws = wb[tcfg["sheet"]]
        rows = list(ws.iter_rows(values_only=True))
        hi = hdr_row(rows); hdr = rows[hi]
        colmap = {}  # col_index -> (key,label,cat)
        for ci,cell in enumerate(hdr):
            if ci==0 or cell is None: continue
            if tcfg["mode"]=="direct":
                name = str(cell).strip()
                if name in tcfg["map"]: colmap[ci]=tcfg["map"][name]
            else:
                parts=[p.strip() for p in str(cell).split("\n")]
                grp=parts[0]; code=parts[1] if len(parts)>1 else ""
                if code=="0" and grp in tcfg["map"]: colmap[ci]=tcfg["map"][grp]
        for ci,(key,label,cat) in colmap.items():
            groups.setdefault(key, {"label":label,"category":cat,"monthly":[]})
        for r in rows[hi+1:]:
            pm = parse_month(r[0]) if r and r[0] is not None else None
            if not pm: continue
            yr,mn,dk = pm
            if (yr,mn) < START_CAP: continue
            for ci,(key,label,cat) in colmap.items():
                v = r[ci] if ci < len(r) else None
                if v is not None and isinstance(v,(int,float)):
                    groups[key]["monthly"].append({"date":dk,"value":round(float(v),1)})
    return groups

def validate(groups):
    errs=[]
    expected = {"all","decile1","decile2","decile5","decile9","decile10","mortgagor","outright","private_renter","social_renter","non_retired","retired","with_children","without_children"}
    missing = expected - set(groups)
    if missing: errs.append(f"missing groups: {missing}")
    latest=set()
    for k,g in groups.items():
        if not g["monthly"]: errs.append(f"{k}: no data"); continue
        latest.add(g["monthly"][-1]["date"])
        for pt in g["monthly"][-12:]:
            if not (-6 <= pt["value"] <= 30): errs.append(f"{k}: implausible {pt['value']} at {pt['date']}")
    if len(latest)>1: errs.append(f"groups disagree on latest month: {latest}")
    return errs, (latest.pop() if len(latest)==1 else None)

def main():
    ts = datetime.datetime.utcnow().isoformat()+"Z"
    print("UKFT RCOL - HCI ingest"); print("-"*50)
    url = sys.argv[1] if len(sys.argv)>1 and sys.argv[1].startswith("http") else resolve_url()
    print(f"Latest xlsx: {url}")
    data = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read()
    print(f"Downloaded {len(data)} bytes")
    groups = parse(data)
    errs, latest = validate(groups)
    print(f"Parsed {len(groups)} groups; latest month: {latest}; window from {START_CAP[0]}-{START_CAP[1]:02d}")
    for k,g in groups.items():
        print(f"  {k:16s} {g['category']:10s} {len(g['monthly'])} pts | latest {g['monthly'][-1]['date']} = {g['monthly'][-1]['value']}%")
    if errs:
        print("VALIDATION ERRORS:"); [print("  -",e) for e in errs]; sys.exit(1)
    doc = {"_meta":{"description":"UKFT RCOL - ONS Household Costs Indices (HCI) 12-month % change by household group",
                    "source":"ONS Household Costs Indices reference tables (xlsx)","source_url":url,
                    "licence":"Open Government Licence v3.0","attribution":"Office for National Statistics",
                    "generated":ts,"measure":"12-month percentage change (payments approach)",
                    "note":"HCI is official statistics in development. Payments approach includes mortgage interest (CPI excludes it). Series capped to common window from Jan 2022."},
           "latest_month":latest,"start_month":f"{START_CAP[0]} {MON[START_CAP[1]]}","groups":groups}
    out = sys.argv[2] if len(sys.argv)>2 else "/tmp/ukft-hci-data.json"
    open(out,"w",encoding="utf-8").write(json.dumps(doc,indent=2))
    print(f"\nok  wrote {out} ({os.path.getsize(out)/1024:.1f} KB)")

if __name__=="__main__": main()
