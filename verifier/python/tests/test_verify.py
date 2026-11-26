import copy
import json
import pathlib

import pytest

from prokura_verify import canonicalize, merkle_leaf, merkle_node, record_hash, verify_nachweis, verify_root
from prokura_verify.__main__ import main

FIX = pathlib.Path(__file__).resolve().parents[3] / "fixtures"
# Prokura's evidence server key, as published in the signed daily roots (GET https://api.prokura.network/v1/roots/{date}).
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
    assert not r["ok"] and r["records"][0]["signature"] == "FAIL"


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
