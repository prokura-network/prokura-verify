"""Command line: python -m prokura_verify FILE [--server-key did:key:...[,did:key:...]] [--record-hash HEX] [--json]"""
from __future__ import annotations

import argparse
import json
import sys

from . import verify_any


def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        prog="prokura-verify",
        description="Verify a Prokura Nachweis, signed daily root, hourly checkpoint or inclusion proof offline.",
    )
    p.add_argument("file", help="nachweis/v1, merkle-root/v1, merkle-checkpoint/v1, merkle-proof/v1 or merkle-checkpoint-proof/v1 JSON")
    p.add_argument("--server-key", help="pin the server key (did:key:z6Mk...); after a rotation, the key ring comma-separated")
    p.add_argument("--record-hash", help="for an inclusion proof: the hash of the record in your Nachweis")
    p.add_argument("--json", action="store_true", help="print the full report as JSON")
    a = p.parse_args(argv)
    keys = [k.strip() for k in a.server_key.split(",") if k.strip()] if a.server_key else None
    try:
        with open(a.file, encoding="utf-8") as f:
            doc = json.load(f)
        report = verify_any(doc, keys, a.record_hash)
    except (OSError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    if a.json:
        print(json.dumps(report, indent=2))
    else:
        for w in report.get("warnings", []):
            print(f"warning: {w}")
        if report["kind"] == "nachweis":
            for r in report["records"]:
                checks = " ".join(f"{k}={v.split(' ')[0]}" for k, v in r.items() if k not in ("id", "kind", "decision"))
                print(f"{r['id']}  {r['kind']:<9} {str(r['decision']):<8} {checks}")
            for label, key in (("server key", "serverKey"), ("server keys", "serverKeys"), ("export proof", "exportProof")):
                if key in report:
                    print(f"{label}: {report[key]}")
        elif report["kind"] == "proof":
            rec = f" record={report['record']}" if "record" in report else ""
            print(f"proof {report['format']} record={report['recordId']} leaf={report['leafIndex']}/{report['treeSize']} "
                  f"signature={report['signature']} inclusion={report['inclusion']}{rec}")
        else:
            print(f"{report['format'] or 'root'} {report['id'] or report['date']} treeSize={report['treeSize']} signature={report['signature']}")
        print("VERIFIED" if report["ok"] else "NOT VERIFIED")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
