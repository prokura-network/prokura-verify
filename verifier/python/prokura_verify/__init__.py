"""Offline verifier for Prokura Nachweis (evidence) files and signed daily roots.

What is checked, and where each rule comes from, is documented in
docs/nachweis-format.md. In short:

  SPEC     = stated in https://prokura.network/llms.txt ("Verify a Nachweis")
  OBSERVED = not written in llms.txt; matches the verifier shipped on the
             prokura.network homepage and real demo files, but may change.

The only third-party dependency is `cryptography` (for Ed25519).
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
from decimal import Decimal
from typing import Any, Dict, List, Optional

__all__ = [
    "GENESIS",
    "canonicalize",
    "record_hash",
    "intent_hash",
    "merkle_leaf",
    "merkle_node",
    "did_key_to_ed25519",
    "verify_nachweis",
    "verify_root",
]

GENESIS = "0" * 64

# Fields of a stored record that go into the last element of the hashed array
# ("the remaining stored fields"). llms.txt does not enumerate them; this list is
# the one used by the in-browser verifier on prokura.network (OBSERVED).
RECORD_FIELDS = [
    "id", "kind", "refId", "mandateId", "agentId", "principalId", "intentHash",
    "stepUp", "gateState", "rail", "railStatus", "amount", "currency", "payee",
]


# ---------------------------------------------------------------------------
# RFC 8785 (JSON Canonicalization Scheme)
# ---------------------------------------------------------------------------

def _jcs_string(s: str) -> str:
    out = ['"']
    for ch in s:
        o = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\f":
            out.append("\\f")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif o < 0x20 or 0xD800 <= o <= 0xDFFF:  # control chars, lone surrogates
            out.append("\\u%04x" % o)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _jcs_number(x: Any) -> str:
    """ECMAScript Number.prototype.toString, as RFC 8785 requires."""
    if isinstance(x, int):
        if abs(x) <= 2**53:
            return str(x)
        x = float(x)
    if not math.isfinite(x):
        raise ValueError("RFC 8785 forbids NaN and Infinity")
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    t = Decimal(repr(abs(x))).normalize().as_tuple()
    digits = "".join(str(d) for d in t.digits)
    k = len(digits)
    n = t.exponent + k  # value = 0.digits * 10^n
    if k <= n <= 21:
        s = digits + "0" * (n - k)
    elif 0 < n <= 21:
        s = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        s = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        s = digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return sign + s


def _utf16_key(s: str) -> bytes:
    return s.encode("utf-16-be", "surrogatepass")


def canonicalize(value: Any) -> str:
    """Serialize a JSON value per RFC 8785."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _jcs_string(value)
    if isinstance(value, (int, float)):
        return _jcs_number(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonicalize(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys(), key=_utf16_key)
        return "{" + ",".join(_jcs_string(k) + ":" + canonicalize(value[k]) for k in keys) + "}"
    raise TypeError(f"not a JSON value: {type(value).__name__}")


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------------------
# Hashes
# ---------------------------------------------------------------------------

def record_hash(record: Dict[str, Any]) -> str:
    """SPEC: SHA-256 over the RFC 8785 canonical JSON array
    [prevHash, intent, decision, reasons, railRef, createdAt, remaining-fields].
    Version 2 records add v, mandateSeq, mandatePrevHash and agentName to the
    remaining fields. A field missing from a v1 record is left out (as JavaScript
    drops `undefined`); the v2 fields are null when missing."""
    rest = {k: record[k] for k in RECORD_FIELDS if k in record}
    v = record.get("v")
    if v == 2 and not isinstance(v, bool):
        rest["v"] = 2
        rest["mandateSeq"] = record.get("mandateSeq")
        rest["mandatePrevHash"] = record.get("mandatePrevHash")
        rest["agentName"] = record.get("agentName")
    arr = [
        record.get("prevHash"),
        record.get("intent"),
        record.get("decision"),
        record.get("reasons"),
        record.get("railRef"),
        record.get("createdAt"),
        rest,
    ]
    return _sha256_hex(canonicalize(arr).encode("utf-8"))


def intent_hash(intent: Dict[str, Any]) -> str:
    """OBSERVED: "sha256:" + hex SHA-256 of the canonical intent (signature included)."""
    return "sha256:" + _sha256_hex(canonicalize(intent).encode("utf-8"))


def merkle_leaf(leaf: bytes) -> bytes:
    """SPEC: leaf hash = SHA-256(0x00 || leaf bytes). Which bytes form a leaf is not specified."""
    return hashlib.sha256(b"\x00" + leaf).digest()


def merkle_node(left: bytes, right: bytes) -> bytes:
    """SPEC: inner node = SHA-256(0x01 || left || right)."""
    return hashlib.sha256(b"\x01" + left + right).digest()


# ---------------------------------------------------------------------------
# Keys and signatures
# ---------------------------------------------------------------------------

_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def _b58decode(s: str) -> bytes:
    n = 0
    for c in s:
        i = _B58.find(c)
        if i < 0:
            raise ValueError("invalid base58 character")
        n = n * 58 + i
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return b"\x00" * (len(s) - len(s.lstrip("1"))) + raw


def did_key_to_ed25519(did: str) -> bytes:
    """did:key:z6Mk... -> 32-byte Ed25519 public key (multicodec 0xed01)."""
    did = did.split("#", 1)[0]
    if not did.startswith("did:key:z"):
        raise ValueError("not a base58btc did:key")
    raw = _b58decode(did[len("did:key:z"):])
    if len(raw) != 34 or raw[0] != 0xED or raw[1] != 0x01:
        raise ValueError("not an Ed25519 did:key")
    return raw[2:]


def _b64url(s: str) -> bytes:
    s = s.strip()
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _ed25519_ok(pub: bytes, sig_b64url: Optional[str], msg: bytes) -> bool:
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    if not isinstance(sig_b64url, str) or not sig_b64url:
        return False
    try:
        Ed25519PublicKey.from_public_bytes(pub).verify(_b64url(sig_b64url), msg)
        return True
    except (InvalidSignature, ValueError):
        return False


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

def _resolve_key(doc_key: Optional[str], pinned: Optional[str], warnings: List[str]) -> Optional[bytes]:
    if pinned:
        if doc_key and doc_key.split("#")[0] != pinned.split("#")[0]:
            warnings.append(f"file names server {doc_key}, but the pinned key is {pinned}; using the pinned key")
        return did_key_to_ed25519(pinned)
    if doc_key:
        warnings.append(
            "server key taken from the file itself (self-asserted). Pin it with --server-key, "
            "e.g. the 'server' value of a signed daily root from GET https://api.prokura.network/v1/roots/{date}"
        )
        return did_key_to_ed25519(doc_key)
    return None


def verify_nachweis(doc: Dict[str, Any], server_key: Optional[str] = None) -> Dict[str, Any]:
    """Verify a Nachweis export ({"format": "nachweis/v1", "records": [...], ...})
    or a bare list of records. Returns a report; report["ok"] is the verdict."""
    warnings: List[str] = []
    if isinstance(doc, list):
        records, doc = doc, {}
    else:
        records = doc.get("records")
    if not isinstance(records, list) or not records:
        raise ValueError("no records found")
    if doc and doc.get("format") not in (None, "nachweis/v1"):
        warnings.append(f"unknown format {doc.get('format')!r}")

    pub = _resolve_key(doc.get("server"), server_key, warnings)
    if pub is None:
        warnings.append("no server key: record signatures not checked")

    subject_id = None
    cred = doc.get("credential")
    if isinstance(cred, dict):
        subject_id = (cred.get("credentialSubject") or {}).get("id")

    results = []
    failures = 0
    prev_hash: Optional[str] = None
    last_by_mandate: Dict[str, Dict[str, Any]] = {}

    for i, r in enumerate(records):
        res: Dict[str, Any] = {"id": r.get("id"), "kind": r.get("kind"), "decision": r.get("decision")}

        # SPEC: hash
        try:
            res["hash"] = "OK" if record_hash(r) == r.get("hash") else "FAIL"
        except (TypeError, ValueError) as e:
            res["hash"] = f"FAIL ({e})"

        # SPEC: chain link
        if i == 0:
            res["link"] = "OK (genesis)" if r.get("prevHash") == GENESIS else "EXTERNAL (chain starts before this file)"
        else:
            res["link"] = "OK" if r.get("prevHash") == prev_hash else "FAIL"
        prev_hash = r.get("hash")

        # SPEC: v2 per-mandate chain
        if r.get("v") == 2 and not isinstance(r.get("v"), bool):
            m = r.get("mandateId")
            last = last_by_mandate.get(m)
            if last is not None:
                ok = r.get("mandatePrevHash") == last.get("hash") and r.get("mandateSeq") == (last.get("mandateSeq") or 0) + 1
                res["mandateLink"] = "OK" if ok else "FAIL"
            elif r.get("mandateSeq") == 1:
                res["mandateLink"] = "OK (genesis)" if r.get("mandatePrevHash") == GENESIS else "FAIL"
            else:
                res["mandateLink"] = "EXTERNAL (earlier records of this mandate are not in this file)"
            last_by_mandate[m] = r

        # SPEC: Ed25519 over the raw 32-byte hash (signature encoding base64url is OBSERVED)
        if pub is not None:
            try:
                raw = bytes.fromhex(r.get("hash", ""))
                res["signature"] = "OK" if len(raw) == 32 and _ed25519_ok(pub, r.get("signature"), raw) else "FAIL"
            except ValueError:
                res["signature"] = "FAIL"

        # OBSERVED: intentHash and the agent's own signature over the intent
        intent = r.get("intent")
        if isinstance(intent, dict) and "intentHash" in r:
            res["intentHash"] = "OK" if intent_hash(intent) == r["intentHash"] else "FAIL"
        if isinstance(intent, dict) and intent.get("agentSignature") and intent.get("agentId"):
            unsigned = {k: v for k, v in intent.items() if k != "agentSignature"}
            try:
                agent_pub = did_key_to_ed25519(intent["agentId"])
                res["agentSignature"] = "OK" if _ed25519_ok(agent_pub, intent["agentSignature"], canonicalize(unsigned).encode("utf-8")) else "FAIL"
            except ValueError:
                res["agentSignature"] = "UNSUPPORTED (agentId is not an Ed25519 did:key)"
            if subject_id:
                res["agentIsCredentialSubject"] = "OK" if intent["agentId"] == subject_id else "FAIL"

        if any(str(v).startswith("FAIL") for k, v in res.items() if k not in ("id", "kind", "decision")):
            failures += 1
        results.append(res)

    report: Dict[str, Any] = {"records": results}

    # OBSERVED: export-level proof = Ed25519 over canonical JSON of the document without "proof"
    proof = doc.get("proof") if doc else None
    if isinstance(proof, dict) and pub is not None:
        body = {k: v for k, v in doc.items() if k != "proof"}
        ok = _ed25519_ok(pub, proof.get("signature"), canonicalize(body).encode("utf-8"))
        vm = proof.get("verificationMethod")
        if vm and doc.get("server") and vm.split("#")[0] != doc["server"].split("#")[0]:
            warnings.append("proof.verificationMethod differs from server")
        report["exportProof"] = "OK" if ok else "FAIL"
        if not ok:
            failures += 1

    report["warnings"] = warnings
    report["ok"] = failures == 0
    return report


def verify_root(doc: Dict[str, Any], server_key: Optional[str] = None) -> Dict[str, Any]:
    """OBSERVED: a signed daily root (GET /v1/roots/{date}) is signed with Ed25519
    over the canonical JSON of the root document without "signature"."""
    warnings: List[str] = []
    pub = _resolve_key(doc.get("server"), server_key, warnings)
    if pub is None:
        raise ValueError("no server key")
    body = {k: v for k, v in doc.items() if k != "signature"}
    ok = _ed25519_ok(pub, doc.get("signature"), canonicalize(body).encode("utf-8"))
    return {"date": doc.get("date"), "root": doc.get("root"), "treeSize": doc.get("treeSize"),
            "signature": "OK" if ok else "FAIL", "warnings": warnings, "ok": ok}
