#!/usr/bin/env python3
"""Export all GHL contacts to organized CSV using curl."""
import subprocess, json, csv, sys

TOKEN = "pit-f8914f6d-60d4-49d8-95a5-806161de3463"
LOC = "RppyffZswOFMBG1U4Xyx"
BASE = "https://services.leadconnectorhq.com"

def fetch(url):
    result = subprocess.run([
        "curl", "-s", "--connect-timeout", "15",
        "-H", f"Authorization: Bearer {TOKEN}",
        "-H", "Version: 2021-07-28",
        "-H", "Accept: application/json",
        url
    ], capture_output=True, text=True, timeout=30)
    return json.loads(result.stdout)

all_contacts = []
page = 1
next_url = f"{BASE}/contacts/?locationId={LOC}&limit=100"

while next_url:
    try:
        data = fetch(next_url)
    except Exception as e:
        print(f"Error on page {page}: {e}", file=sys.stderr)
        break

    contacts = data.get("contacts", [])
    if not contacts:
        break

    all_contacts.extend(contacts)
    meta = data.get("meta", {})
    total = meta.get("total", "?")
    print(f"Page {page}: {len(contacts)} contacts (total so far: {len(all_contacts)} / {total})", file=sys.stderr)
    page += 1

    next_url = meta.get("nextPageUrl")

print(f"\nTotal contacts retrieved: {len(all_contacts)}", file=sys.stderr)

# Sort: contacts with companies first, grouped by source, newest first within groups
def sort_key(c):
    has_company = 0 if c.get("companyName") else 1
    source = (c.get("source") or "zzz").lower()
    return (has_company, source)

all_contacts.sort(key=sort_key)

# Write CSV
outpath = "/workspace/synced/opai/notes/Archive/GHL-Contacts-Export.csv"
with open(outpath, "w", newline="") as f:
    writer = csv.writer(f)
    writer.writerow([
        "Company", "Contact Name", "First Name", "Last Name",
        "Email", "Phone", "Source", "Tags",
        "Type", "City", "State", "Country", "Postal Code", "Address",
        "Website", "DND", "Date Added", "Date Updated", "GHL ID"
    ])
    for c in all_contacts:
        writer.writerow([
            c.get("companyName") or "",
            c.get("contactName") or "",
            c.get("firstNameRaw") or c.get("firstName") or "",
            c.get("lastNameRaw") or c.get("lastName") or "",
            c.get("email") or "",
            c.get("phone") or "",
            c.get("source") or "",
            "; ".join(c.get("tags") or []),
            c.get("type") or "",
            c.get("city") or "",
            c.get("state") or "",
            c.get("country") or "",
            c.get("postalCode") or "",
            c.get("address1") or "",
            c.get("website") or "",
            str(c.get("dnd") or ""),
            (c.get("dateAdded") or "")[:19],
            (c.get("dateUpdated") or "")[:19],
            c.get("id") or ""
        ])

print(f"\nCSV written to: {outpath}", file=sys.stderr)
