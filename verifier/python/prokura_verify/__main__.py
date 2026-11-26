"""Command line: python -m prokura_verify FILE [--server-key did:key:...] [--json]"""
from __future__ import annotations

import argparse
import json
import sys

from . import verify_nachweis, verify_root


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="prokura-verify", description="Verify a Prokura Nachweis or signed daily root offline.")
    p.add_argument("file", help="Nachweis JSON (nachweis/v1) or daily root JSON (merkle-root/v1)")
    p.add_argument("--server-key", help="pin the expected server key (did:key:z6Mk...)")
    p.add_argument("--json", action="store_true", help="print the full report as JSON")
    a = p.parse_args(argv)
    try:
        with open(a.file, encoding="utf-8") as f:
            doc = json.load(f)
        if isinstance(doc, dict) and doc.get("format") == "merkle-root/v1":
            report = verify_root(doc, a.server_key)
        else:
            report = verify_nachweis(doc, a.server_key)
    except (OSError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    if a.json:
        print(json.dumps(report, indent=2))
    else:
        for w in report.get("warnings", []):
            print(f"warning: {w}")
        if "records" in report:
            for r in report["records"]:
                checks = " ".join(f"{k}={v.split(' ')[0]}" for k, v in r.items() if k not in ("id", "kind", "decision"))
                print(f"{r['id']}  {r['kind']:<9} {str(r['decision']):<8} {checks}")
            if "exportProof" in report:
                print(f"export proof: {report['exportProof']}")
        else:
            print(f"root {report['date']} treeSize={report['treeSize']} signature={report['signature']}")
        print("VERIFIED" if report["ok"] else "NOT VERIFIED")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
