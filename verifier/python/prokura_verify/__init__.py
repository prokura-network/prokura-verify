"""Offline verifier for Prokura Nachweis exports, signed daily roots, hourly
checkpoints and Merkle inclusion proofs.

Every rule is specified in docs/nachweis-format.md; section numbers in the
comments below (§n) refer to that document.

The only third-party dependency is `cryptography` (for Ed25519).
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import re
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Union

__all__ = [
    "GENESIS",
    "canonicalize",
    "record_hash",
    "intent_hash",
    "merkle_leaf",
    "merkle_node",
    "record_leaf",
    "merkle_root",
    "inclusion_proof",
    "verify_inclusion",
    "server_key_at",
    "did_key_to_ed25519",
    "verify_nachweis",
    "verify_root",
    "verify_proof",
    "verify_any",
]

GENESIS = "0" * 64

# §3.2: the remaining stored fields, in the object that closes the hashed array.
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
    """§3.2: SHA-256 over the RFC 8785 canonical JSON array
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
    """§3.4: "sha256:" + hex SHA-256 of the canonical intent, agentSignature included."""
    return "sha256:" + _sha256_hex(canonicalize(intent).encode("utf-8"))


def merkle_leaf(leaf: bytes) -> bytes:
    """§5: RFC 9162 leaf hash, SHA-256(0x00 || data)."""
    return hashlib.sha256(b"\x00" + leaf).digest()


def merkle_node(left: bytes, right: bytes) -> bytes:
    """§5: RFC 9162 node hash, SHA-256(0x01 || left || right)."""
    return hashlib.sha256(b"\x01" + left + right).digest()


def record_leaf(record_hash_hex: str) -> bytes:
    """§5: the leaf of an evidence record is its 32-byte hash (raw bytes of the hex `hash`)."""
    return merkle_leaf(bytes.fromhex(record_hash_hex))


def _split(n: int) -> int:
    k = 1
    while k * 2 < n:
        k *= 2
    return k


def merkle_root(leaves: Sequence[bytes]) -> bytes:
    """§5: Merkle Tree Hash over leaf hashes (RFC 9162 §2.1.1). Empty tree = SHA-256("")."""
    if not leaves:
        return hashlib.sha256(b"").digest()
    if len(leaves) == 1:
        return leaves[0]
    k = _split(len(leaves))
    return merkle_node(merkle_root(leaves[:k]), merkle_root(leaves[k:]))


def inclusion_proof(m: int, leaves: Sequence[bytes]) -> List[bytes]:
    """§5: audit path for leaf m (RFC 9162 §2.1.3.1)."""
    if m < 0 or m >= len(leaves):
        raise IndexError("leaf index out of range")
    if len(leaves) == 1:
        return []
    k = _split(len(leaves))
    if m < k:
        return inclusion_proof(m, leaves[:k]) + [merkle_root(leaves[k:])]
    return inclusion_proof(m - k, leaves[k:]) + [merkle_root(leaves[:k])]


def verify_inclusion(leaf: bytes, index: Any, tree_size: Any, path: Sequence[bytes], root: bytes) -> bool:
    """§5: verify an audit path (RFC 9162 §2.1.3.2)."""
    if isinstance(index, bool) or isinstance(tree_size, bool) or not isinstance(index, int) or not isinstance(tree_size, int):
        return False
    if index < 0 or index >= tree_size:
        return False
    fn, sn, r = index, tree_size - 1, leaf
    for p in path:
        if sn == 0:
            return False
        if fn % 2 == 1 or fn == sn:
            r = merkle_node(p, r)
            if fn % 2 == 0:
                while fn % 2 == 0 and fn != 0:
                    fn >>= 1
                    sn >>= 1
        else:
            r = merkle_node(r, p)
        fn >>= 1
        sn >>= 1
    return sn == 0 and r == root


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

PinnedKeys = Union[None, str, Iterable[str]]

_SELF_ASSERTED = (
    "server key taken from the file itself (self-asserted). Pin it with --server-key: the 'evidence' key "
    "from GET https://api.prokura.network/v1/public/keys, or the 'server' of a signed daily root"
)


def _bare(did: str) -> str:
    return did.split("#", 1)[0]


def _pinned_set(pinned: PinnedKeys) -> Optional[Set[str]]:
    if pinned is None:
        return None
    keys = [pinned] if isinstance(pinned, str) else list(pinned)
    keys = [_bare(k.strip()) for k in keys if k and k.strip()]
    return set(keys) or None


def _parse_time(s: Any) -> Optional[float]:
    from datetime import datetime

    if not isinstance(s, str):
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def server_key_at(keys: Any, created_at: Any, fallback: str) -> str:
    """§4: the key that signed a record: the serverKeys window containing its createdAt, else `server`."""
    t = _parse_time(created_at)
    if not isinstance(keys, list) or t is None:
        return fallback
    for w in keys:
        if not isinstance(w, dict) or not isinstance(w.get("id"), str):
            continue
        start, end = _parse_time(w.get("validFrom")), _parse_time(w.get("validUntil"))
        if start is not None and start <= t and (w.get("validUntil") is None or (end is not None and t < end)):
            return w["id"]
    return fallback


def _key_bytes(did: str) -> Optional[bytes]:
    try:
        return did_key_to_ed25519(did)
    except ValueError:
        return None


def verify_nachweis(doc: Any, server_key: PinnedKeys = None) -> Dict[str, Any]:
    """Verify a Nachweis export ({"format": "nachweis/v1", "records": [...], ...})
    or a bare list of records. `server_key` is one did:key or a list (the published
    key ring). Returns a report; report["ok"] is the verdict."""
    warnings: List[str] = []
    if isinstance(doc, list):
        records, doc = doc, {}
    else:
        records = doc.get("records")
    if not isinstance(records, list) or not records:
        raise ValueError("no records found")
    if doc and doc.get("format") not in (None, "nachweis/v1"):
        warnings.append(f"unknown format {doc.get('format')!r}")

    pinned = _pinned_set(server_key)
    if isinstance(doc.get("server"), str):
        server: Optional[str] = _bare(doc["server"])
    else:  # a bare list of records: a single pinned key stands in for `server`
        server = next(iter(pinned)) if pinned and len(pinned) == 1 else None
    if server is None:
        warnings.append("no server key: record signatures not checked")
    elif pinned is None:
        warnings.append(_SELF_ASSERTED)

    subject_id = None
    cred = doc.get("credential")
    if isinstance(cred, dict):
        subject_id = (cred.get("credentialSubject") or {}).get("id")

    report: Dict[str, Any] = {}
    failures = 0
    if pinned and server and server not in pinned:
        report["serverKey"] = f"FAIL ({server} is not a pinned key)"
        failures += 1
    if "serverKeys" in doc:
        sk = doc.get("serverKeys")
        listed = isinstance(sk, list) and any(isinstance(k, dict) and k.get("id") == doc.get("server") for k in sk)
        report["serverKeys"] = "OK" if listed else "FAIL (serverKeys does not list the export's server key)"
        if not listed:
            failures += 1

    results = []
    prev_hash: Optional[str] = None
    last_by_mandate: Dict[str, Dict[str, Any]] = {}

    for i, r in enumerate(records):
        res: Dict[str, Any] = {"id": r.get("id"), "kind": r.get("kind"), "decision": r.get("decision")}

        # §3.2: hash
        try:
            res["hash"] = "OK" if record_hash(r) == r.get("hash") else "FAIL"
        except (TypeError, ValueError) as e:
            res["hash"] = f"FAIL ({e})"

        # §3.3: chain link
        if i == 0:
            res["link"] = "OK (genesis)" if r.get("prevHash") == GENESIS else "EXTERNAL (chain starts before this file)"
        else:
            res["link"] = "OK" if r.get("prevHash") == prev_hash else "FAIL"
        prev_hash = r.get("hash")

        # §3.3: v2 per-mandate chain
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

        # §3.5 and §4: Ed25519 over the raw 32-byte hash, by the key valid at createdAt
        if server is not None:
            key = server_key_at(doc.get("serverKeys"), r.get("createdAt"), server)
            if pinned and key not in pinned:
                res["signature"] = f"FAIL (signed by {key}, which is not pinned)"
            else:
                pub = _key_bytes(key)
                try:
                    raw = bytes.fromhex(r.get("hash", ""))
                    res["signature"] = "OK" if pub and len(raw) == 32 and _ed25519_ok(pub, r.get("signature"), raw) else "FAIL"
                except (TypeError, ValueError):
                    res["signature"] = "FAIL"

        # §3.4 and §3.6: intentHash and the agent's own signature over the intent
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

    report["records"] = results

    # §3.7: export proof = Ed25519 by `server` over JCS(document without "proof")
    proof = doc.get("proof") if doc else None
    if isinstance(proof, dict) and isinstance(doc.get("server"), str):
        body = {k: v for k, v in doc.items() if k != "proof"}
        pub = _key_bytes(_bare(doc["server"]))
        ok = bool(pub) and _ed25519_ok(pub, proof.get("signature"), canonicalize(body).encode("utf-8"))
        vm = proof.get("verificationMethod")
        by_server = not isinstance(vm, str) or _bare(vm) == _bare(doc["server"])
        if ok and by_server:
            report["exportProof"] = "OK"
        else:
            report["exportProof"] = "FAIL" if by_server else "FAIL (proof.verificationMethod is not the server key)"
            failures += 1

    report["warnings"] = warnings
    report["ok"] = failures == 0
    return report


_TREE_HEADS = ("merkle-root/v1", "merkle-checkpoint/v1")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def verify_root(doc: Dict[str, Any], server_key: PinnedKeys = None) -> Dict[str, Any]:
    """§6: a signed daily root (merkle-root/v1) or hourly checkpoint (merkle-checkpoint/v1):
    Ed25519 by `server` over the canonical JSON of the document without "signature"."""
    if not isinstance(doc, dict):
        raise ValueError("not a JSON object")
    warnings: List[str] = []
    if doc.get("format") not in (None,) + _TREE_HEADS:
        warnings.append(f"unknown format {doc.get('format')!r}")
    pinned = _pinned_set(server_key)
    if isinstance(doc.get("server"), str):
        server: Optional[str] = _bare(doc["server"])
    else:
        server = next(iter(pinned)) if pinned and len(pinned) == 1 else None
    if server is None:
        raise ValueError("no server key")
    if pinned is None:
        warnings.append(_SELF_ASSERTED)
    if pinned and server not in pinned:
        sig = f"FAIL ({server} is not a pinned key)"
    else:
        pub = _key_bytes(server)
        body = {k: v for k, v in doc.items() if k != "signature"}
        sig = "OK" if pub and _ed25519_ok(pub, doc.get("signature"), canonicalize(body).encode("utf-8")) else "FAIL"
    return {"format": doc.get("format"), "date": doc.get("date"), "id": doc.get("id"), "root": doc.get("root"),
            "treeSize": doc.get("treeSize"), "signature": sig, "warnings": warnings, "ok": sig == "OK"}


def verify_proof(doc: Dict[str, Any], server_key: PinnedKeys = None, record_hash: Optional[str] = None) -> Dict[str, Any]:
    """§5: an inclusion proof (merkle-proof/v1 with `root`, or merkle-checkpoint-proof/v1 with
    `checkpoint`): the signed tree head verifies and the record's leaf is in it. Pass
    `record_hash` (the `hash` of the record in your Nachweis) to bind the proof to it."""
    if not isinstance(doc, dict):
        raise ValueError("not a JSON object")
    checkpoint = doc.get("format") == "merkle-checkpoint-proof/v1"
    head = doc.get("checkpoint" if checkpoint else "root")
    head_format = "merkle-checkpoint/v1" if checkpoint else "merkle-root/v1"
    if not isinstance(head, dict):
        raise ValueError(f"proof has no {head_format} document")
    signed = verify_root(head, server_key)
    warnings = list(signed["warnings"])
    path = doc.get("auditPath")
    rh = doc.get("recordHash")
    if head.get("format") != head_format:
        inclusion = f"FAIL (expected a {head_format} document)"
    elif not isinstance(rh, str) or not _HEX64.match(rh):
        inclusion = "FAIL (recordHash is not 64 hex)"
    elif not isinstance(head.get("root"), str) or not _HEX64.match(head["root"]):
        inclusion = "FAIL (root is not 64 hex)"
    elif not isinstance(path, list) or not all(isinstance(h, str) and _HEX64.match(h) for h in path):
        inclusion = "FAIL (auditPath must be a list of 64-hex hashes)"
    else:
        ok = verify_inclusion(record_leaf(rh), doc.get("leafIndex"), head.get("treeSize"),
                              [bytes.fromhex(h) for h in path], bytes.fromhex(head["root"]))
        inclusion = "OK" if ok else "FAIL"
    report: Dict[str, Any] = {"format": doc.get("format"), "recordId": doc.get("recordId"), "recordHash": rh,
                              "leafIndex": doc.get("leafIndex"), "treeSize": head.get("treeSize"),
                              "signature": signed["signature"], "inclusion": inclusion}
    if record_hash is not None:
        report["record"] = "OK" if record_hash == rh else "FAIL (proof is for a different record hash)"
    else:
        warnings.append("proof not bound to a record: pass the record's hash (--record-hash) to check it is the one in your Nachweis")
    report["warnings"] = warnings
    report["ok"] = signed["ok"] and inclusion == "OK" and report.get("record", "OK") == "OK"
    return report


def verify_any(doc: Any, server_key: PinnedKeys = None, record_hash: Optional[str] = None) -> Dict[str, Any]:
    """Dispatch on `format`: a Nachweis export, a signed root or checkpoint, or an inclusion proof."""
    f = doc.get("format") if isinstance(doc, dict) else None
    if f in _TREE_HEADS:
        return {"kind": "tree-head", **verify_root(doc, server_key)}
    if f in ("merkle-proof/v1", "merkle-checkpoint-proof/v1"):
        return {"kind": "proof", **verify_proof(doc, server_key, record_hash)}
    return {"kind": "nachweis", **verify_nachweis(doc, server_key)}
