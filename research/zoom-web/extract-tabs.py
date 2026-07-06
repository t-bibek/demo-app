#!/usr/bin/env python3
# Extract the tab-strip labels (AXTabButton AXDescription + AXSelected) from a
# chrome-window AXSnapshot JSON dump. Prints one row per tab.
#   usage: extract-tabs.py <chrome-window-*.json> [<more.json> ...]
import json, sys, glob, os

def rows(path):
    d = json.load(open(path))
    out = []
    def walk(n):
        if not isinstance(n, dict):
            return
        if n.get('subrole') == 'AXTabButton' or n.get('role') == 'AXTabButton':
            out.append((n.get('description'), n.get('selected'),
                        (n.get('frame') or {})))
        for c in (n.get('children') or []):
            walk(c)
    walk(d.get('tree', {}))
    return out, d.get('meta', {})

for pat in sys.argv[1:]:
    for path in sorted(glob.glob(pat)) or [pat]:
        if not os.path.exists(path):
            print(f"!! missing: {path}"); continue
        r, meta = rows(path)
        print(f"== {os.path.basename(path)}  ({meta.get('nodeCount')} nodes) ==")
        if not r:
            print("   (no tab buttons found)")
        for desc, sel, fr in r:
            mark = 'SELECTED' if sel else '        '
            frs = f"@({fr.get('x',0):.0f},{fr.get('y',0):.0f} {fr.get('w',0):.0f}x{fr.get('h',0):.0f})" if fr else ''
            print(f"   [{mark}] {desc!r} {frs}")
        print()
