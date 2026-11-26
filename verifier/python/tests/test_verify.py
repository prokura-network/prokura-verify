import copy
import json
import pathlib

import pytest

import re

from prokura_verify import (
    canonicalize, inclusion_proof, merkle_leaf, merkle_node, merkle_root, record_hash, record_leaf,
    verify_any, verify_inclusion, verify_nachweis, verify_proof, verify_root,
)
from prokura_verify.__main__ import main

FIX = pathlib.Path(__file__).resolve().parents[3] / "fixtures"
# Our evidence server key, as published at GET https://api.prokura.network/v1/public/keys and in every signed daily root.
SERVER = "did:key:z6MksY9Gi8N1cbigCxWyR53eLdiTUUTaxq2A1c6mZe5Lea4L"
REAL = ["nachweis-demo-allow.json", "nachweis-demo-step-up.json", "nachweis-demo-deny.json"]


def fx(name):
    return json.loads((FIX / name).read_text(encoding="utf-8"))


@pytest.mark.parametrize("name", REAL)
def test_real_demo_nachweis_verifies(name):
    r = verify_nachweis(fx(name), SERVER)
    assert r["ok"], json.dumps(r, indent=2)
    assert r["exportProof"] == "OK"
    for rec in r["records"]:
        assert rec["hash"] == "OK" and rec["signature"] == "OK"
        assert rec["mandateLink"].startswith("OK")


def test_root_verifies():
    assert verify_root(fx("root-2026-11-25.json"), SERVER)["ok"]


def test_tampered_amount():
    d = fx("nachweis-demo-allow.json")
    d["records"][1]["amount"] = "1200.00"
    r = verify_nachweis(d, SERVER)
    assert not r["ok"] and r["records"][1]["hash"] == "FAIL"


def test_rehashed_record_fails_signature():
    d = fx("nachweis-demo-allow.json")
    d["records"][1]["amount"] = "99.00"
    d["records"][1]["hash"] = record_hash(d["records"][1])
    r = verify_nachweis(d, SERVER)
    assert r["records"][1]["hash"] == "OK"
    assert r["records"][1]["signature"] == "FAIL"
    assert not r["ok"]


def test_removed_record_breaks_chain():
    d = fx("nachweis-demo-allow.json")
    del d["records"][2]
    r = verify_nachweis(d, SERVER)
    assert r["records"][2]["link"] == "FAIL" and not r["ok"]


def test_wrong_key():
    r = verify_nachweis(fx("nachweis-demo-allow.json"), fx("synthetic-chain.json")["server"])
    assert not r["ok"] and r["records"][0]["signature"].startswith("FAIL")
    assert r["serverKey"].startswith("FAIL")


def test_tampered_export_and_root():
    d = fx("nachweis-demo-allow.json")
    d["subject"] = "x"
    assert verify_nachweis(d, SERVER)["exportProof"] == "FAIL"
    root = fx("root-2026-11-25.json")
    root["treeSize"] = 1
    assert not verify_root(root, SERVER)["ok"]


def test_synthetic_chain_v1_and_genesis():
    d = fx("synthetic-chain.json")
    r = verify_nachweis(d, d["server"])
    assert r["ok"], json.dumps(r, indent=2)
    assert r["records"][0]["link"] == "OK (genesis)"
    assert r["records"][1]["mandateLink"] == "OK (genesis)"


def test_jcs_vectors_match_typescript():
    for v in fx("jcs-vectors.json"):
        assert canonicalize(v["input"]) == v["canonical"]


def test_merkle_prefixes():
    a = merkle_leaf(b"a")
    assert len(a) == 32 and merkle_node(a, a) != merkle_leaf(a + a)


def test_cli_exit_codes(tmp_path, capsys):
    assert main([str(FIX / "nachweis-demo-allow.json"), "--server-key", SERVER]) == 0
    d = fx("nachweis-demo-allow.json")
    d["records"][0]["reasons"] = ["OK", "FOUR_EYES_REQUIRED"]
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps(d))
    assert main([str(bad), "--server-key", SERVER]) == 1
    assert main([str(tmp_path / "missing.json")]) == 2


def test_signatures_are_padded_base64url():
    sigs = [fx("root-2026-11-25.json")["signature"]]
    for name in REAL:
        d = fx(name)
        sigs += [r["signature"] for r in d["records"]] + [d["proof"]["signature"]]
    for s in sigs:
        assert re.fullmatch(r"[A-Za-z0-9_-]{86}==", s), s


def test_merkle_vectors_match_typescript():
    vectors = fx("merkle-vectors.json")["vectors"]
    assert vectors[0]["root"] == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    for v in vectors:
        leaves = [record_leaf(h) for h in v["recordHashes"]]
        assert merkle_root(leaves).hex() == v["root"], v["treeSize"]
        for m, leaf in enumerate(leaves):
            assert [h.hex() for h in inclusion_proof(m, leaves)] == v["auditPaths"][m]
            path = [bytes.fromhex(h) for h in v["auditPaths"][m]]
            assert verify_inclusion(leaf, m, v["treeSize"], path, bytes.fromhex(v["root"]))
            if v["treeSize"] > 1:
                assert not verify_inclusion(leaf, (m + 1) % v["treeSize"], v["treeSize"], path, bytes.fromhex(v["root"]))


def test_merkle_odd_leaf_is_promoted():
    a, b, c = (merkle_leaf(x) for x in (b"a", b"b", b"c"))
    assert merkle_root([a, b, c]) == merkle_node(merkle_node(a, b), c)
    assert merkle_root([a, b, c]) != merkle_root([a, b, c, c])


def test_signed_inclusion_proofs():
    p = fx("synthetic-proofs.json")
    chain = fx("synthetic-chain.json")
    r = verify_proof(p["rootProof"], chain["server"], chain["records"][1]["hash"])
    assert r["ok"] and r["record"] == "OK", json.dumps(r, indent=2)
    c = verify_any(p["checkpointProof"], chain["server"], chain["records"][2]["hash"])
    assert c["kind"] == "proof" and c["ok"], json.dumps(c, indent=2)
    assert verify_any(p["checkpointProof"]["checkpoint"], chain["server"])["ok"]


def test_tampered_inclusion_proofs():
    chain = fx("synthetic-chain.json")
    key = chain["server"]
    edits = {
        "leaf index": lambda p: p.update(leafIndex=0),
        "record hash": lambda p: p.update(recordHash=chain["records"][0]["hash"]),
        "audit path": lambda p: p["auditPath"].__setitem__(0, "0" * 64),
        "root value": lambda p: p["root"].update(root="0" * 64),
        "tree size": lambda p: p["root"].update(treeSize=4),
        "bool index": lambda p: p.update(leafIndex=True),
    }
    for name, edit in edits.items():
        p = copy.deepcopy(fx("synthetic-proofs.json")["rootProof"])
        edit(p)
        assert not verify_proof(p, key)["ok"], name
    p = fx("synthetic-proofs.json")["rootProof"]
    assert not verify_proof(p, key, chain["records"][0]["hash"])["ok"]
    assert not verify_proof(p, SERVER)["ok"]


def test_key_rotation():
    d = fx("synthetic-rotation.json")
    ring = [k["id"] for k in d["serverKeys"]]
    r = verify_nachweis(d, ring)
    assert r["ok"] and r["serverKeys"] == "OK", json.dumps(r, indent=2)
    cur = verify_nachweis(d, d["server"])
    assert not cur["ok"]
    assert cur["records"][0]["signature"].startswith("FAIL") and cur["records"][1]["signature"] == "OK"
    t = fx("synthetic-rotation.json")
    t["serverKeys"][0]["validUntil"] = t["serverKeys"][1]["validFrom"] = "2026-02-01T08:00:00.000Z"
    assert not verify_nachweis(t, ring)["ok"]


def test_cli_proof_and_key_ring(tmp_path):
    p = fx("synthetic-proofs.json")
    chain = fx("synthetic-chain.json")
    f = tmp_path / "proof.json"
    f.write_text(json.dumps(p["rootProof"]))
    assert main([str(f), "--server-key", chain["server"], "--record-hash", chain["records"][1]["hash"]]) == 0
    assert main([str(f), "--server-key", chain["server"], "--record-hash", chain["records"][0]["hash"]]) == 1
    d = fx("synthetic-rotation.json")
    ring = ",".join(k["id"] for k in d["serverKeys"])
    assert main([str(FIX / "synthetic-rotation.json"), "--server-key", ring]) == 0
    assert main([str(FIX / "synthetic-rotation.json"), "--server-key", d["server"]]) == 1
