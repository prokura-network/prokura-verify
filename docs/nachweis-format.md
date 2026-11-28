# Nachweis format (v1)

This is the specification of the evidence Prokura writes: evidence records, the `nachweis/v1` export, our server keys, the Merkle trees over each day of evidence, and the signed roots and checkpoints we publish. The verifiers in [`verifier/`](../verifier) implement every rule on this page, and the section numbers (§n) in their source refer to it.

Our gate writes one evidence record for every decision and every event that follows from it. Records are hash-chained, each one is signed with our server key, and a Nachweis export bundles the records of one decision (or one mandate) with the credential they were made under. Anyone can check all of it offline.

## 1. Conventions

| Term | Meaning |
|---|---|
| `JCS(x)` | RFC 8785 JSON Canonicalization Scheme of `x`, as UTF-8 bytes. Numbers follow RFC 8785 §3.2.2.3. Amounts are decimal strings, so they never go through number formatting. |
| `SHA-256(x)` | SHA-256 of bytes `x`. Record hashes, roots and audit paths are written as 64 lower-case hex characters. |
| `sig` | Ed25519 (RFC 8032) signature, written as **base64url with `=` padding** (RFC 4648 §5): 86 characters followed by `==`. |
| key | `did:key` with a base58btc multibase Ed25519 public key: `did:key:z6Mk…`, multicodec prefix `0xed 0x01` followed by the 32-byte key. |
| time | ISO 8601 with an offset, written by us in UTC with milliseconds (`2026-11-25T10:31:07.123Z`). |

Verifiers should accept unpadded base64url as well, since the signature bytes are the same either way.

## 2. Evidence record

```jsonc
{
  "id": "01M8C9B5F57A16FPSDZP8G8M31",   // ULID
  "prevHash": "<64 hex>",               // hash of the previous record in the global chain
  "hash": "<64 hex>",                   // §3.2
  "kind": "pay",                        // check | pay | approval | rejection | execution | rail_status | revocation | delegation | expiry
  "refId": null,                        // the record this one follows from (a decision, or a mandate event), else null
  "mandateId": "01M8C99TD64W7PVCKF0X97TESV",
  "agentId": "did:key:z6Mk…",           // null for events without an agent
  "principalId": "did:web:…",           // the credential issuer
  "intent": { … },                      // §2.1, null for records without an intent
  "intentHash": "sha256:<64 hex>",      // §3.4, null when intent is null
  "decision": "allow",                  // allow | step_up | deny, null for events
  "reasons": ["OK"],                    // closed list, see reason-codes.md
  "stepUp": null,                       // passkey assertion for approval and rejection records
  "gateState": { … },                   // §2.2, the gate's inputs besides credential and intent
  "rail": "mollie",
  "railRef": null,                      // the rail's reference once a payment executed
  "railStatus": null,
  "amount": "12.00",                    // decimal string, two fraction digits
  "currency": "EUR",
  "payee": { "type": "domain", "value": "shop.example" },
  "createdAt": "2026-11-25T10:31:07.123Z",
  "signature": "<sig>",                 // §3.5
  "v": 2,                               // hash version, absent on version 1 records
  "mandateSeq": 3,                      // v2: position among this mandate's records, from 1
  "mandatePrevHash": "<64 hex>",        // v2: hash of this mandate's previous record, 64 zeros for the first
  "agentName": "my-agent"               // v2: self-declared by the agent, never verified, may be null
}
```

Every field up to `signature` is always present; an empty value is `null` (`reasons` is `[]`).

### 2.1 Intent

The payment intent as the agent signed it:

| Field | Rule |
|---|---|
| `mandateId` | the mandate the agent pays under |
| `agentId` | the agent's `did:key` |
| `amount` | decimal string with exactly two fraction digits, `^(0\|[1-9]\d{0,15})\.\d{2}$` |
| `currency` | ISO 4217 code or a stablecoin ticker such as `USDC`, `^[A-Z]{3,5}$` |
| `payee` | §2.3 |
| `purpose` | a purpose code the mandate lists |
| `reference` | object, `{}` when empty: optional `po`, `invoiceHash` (`sha256:<64 hex>`), `description` (≤ 255), `item` (≤ 64), `resource` (the paid URL for x402) |
| `rail` | the rail that would execute the payment, e.g. `mollie`, `x402` |
| `protocol` | the protocol the intent came in on: `mcp`, `ap2`, `tap` or `acp` |
| `mcc` | optional four-digit merchant category code |
| `nonce` | `^[A-Za-z0-9_-]{16,64}$`, unique per agent |
| `createdAt` | must be within five minutes of the gate's clock |
| `agentSignature` | §3.6 |

### 2.2 Gate state

`gateState` records everything the gate saw besides the credential and the intent, so a decision can be re-run later: `now`, `spentThisPeriod` (decimal string), `seenInvoiceHashes` and `seenNonces` (only the values relevant to this intent), `revocationBit`, `credentialProofValid` and `stepUpApproved`.

### 2.3 Payee

A payee is one of two types:

| `type` | `value` | Matches a mandate entry when |
|---|---|---|
| `iban` | IBAN without spaces, `^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$` | it is the same IBAN |
| `domain` | lower-case domain name | it is the entry's domain or a subdomain of it |

Both carry an optional display `name`. Payments over x402 use the `domain` type: the payee is the domain of the paid resource, and the resource URL goes into `reference.resource` (see [`integrations/x402`](../integrations/x402/README.md)). There is no wallet-address payee type in v1.

## 3. Verification rules

### 3.1 Genesis

The first record of the global chain has `prevHash` = 64 zeros. The first record of each mandate (v2) has `mandateSeq` = 1 and `mandatePrevHash` = 64 zeros.

### 3.2 Record hash

```text
hash = hex(SHA-256(JCS([prevHash, intent, decision, reasons, railRef, createdAt, rest])))
```

`rest` is an object with exactly these keys: `id, kind, refId, mandateId, agentId, principalId, intentHash, stepUp, gateState, rail, railStatus, amount, currency, payee`. For a record with `v: 2`, `rest` also contains `v: 2`, `mandateSeq`, `mandatePrevHash` and `agentName` (`null` when absent). A record without `v` is hashed without those four keys, so records written before version 2 still verify. JCS sorts the keys, so their order above does not matter.

### 3.3 Chain links

- **Global chain:** each record's `prevHash` is the `hash` of the record before it in our ledger. An export holds a slice of that chain, so its first record usually links to a record outside the file; verifiers report that as `EXTERNAL`, not as a failure.
- **Mandate chain (v2):** within one mandate, `mandatePrevHash` is the `hash` of that mandate's previous record and `mandateSeq` goes up by one.

### 3.4 Intent hash

```text
intentHash = "sha256:" + hex(SHA-256(JCS(intent)))
```

over the whole intent object as stored in the record, **including** `agentSignature`, and with `reference` as stored (`{}` when the agent sent none). Approval and rejection records carry the `intentHash` of the decision they settle.

### 3.5 Server signature on a record

`signature = sig` by the server key (§4) over the **32 raw bytes** of `hash` (not the hex string, not JCS). The same acceptance rules apply to every Ed25519 signature in this format (`agentSignature`, the export `proof`, and the signatures on roots, checkpoints and proofs):

- Decode A (the public key) and R (the first 32 bytes of the signature) as in RFC 8032 §5.1.3: reject the signature if the encoding is not 32 bytes or if the recovered y-coordinate is ≥ p (p = 2²⁵⁵ − 19).
- Reject the signature if S (the last 32 bytes, read as a little-endian integer) is ≥ L, where L = 2²⁵² + 27742317777372353535851937790883648493 (RFC 8032 §5.1.7).
- Reject the signature if A or R is one of the eight points of order 1, 2, 4 or 8 on edwards25519. Implementations of the RFC 8032 verification equation disagree on these inputs (see RFC 8032 §8); both verifiers in this repository reject them, so a signature that only verifies under a cofactored check against a small-order key or R is still rejected. The eight compressed encodings are listed in [`fixtures/ed25519-strict-vectors.json`](../fixtures/ed25519-strict-vectors.json).
- Then apply the RFC 8032 verification equation.

`fixtures/ed25519-strict-vectors.json` has a valid signature, a non-canonical S (S + L), the identity-key zero-signature case, and other small-order points. Both verifiers must agree on every vector.

### 3.6 Agent signature on an intent

`agentSignature = sig` by `intent.agentId` over `JCS(intent without agentSignature)`. The agent must be the credential subject (`credential.credentialSubject.id`); otherwise the gate answers `AGENT_MISMATCH`.

### 3.7 Export (`nachweis/v1`) and its proof

```jsonc
{
  "format": "nachweis/v1",
  "exportedAt": "…",
  "subject": "<id of the record this export is about>",
  "records": [ /* the subject and the records that follow from it, in chain order;
                  a session export holds the mandate's whole chain */ ],
  "credential": { /* the mandate: a W3C Verifiable Credential 2.0 */ },
  "issuerDidDocument": { /* optional: the did:web issuer's DID document as we know it */ },
  "server": "did:key:z6Mk…",           // the key that signs this export
  "serverKeys": [ /* only after a key rotation, §4 */ ],
  "proof": { "type": "Ed25519Canonical", "verificationMethod": "<server>", "signature": "<sig>" }
}
```

`proof.signature = sig` by `server` over `JCS(export without "proof")`, and `proof.verificationMethod` equals `server`. Every top-level field except `proof` is covered, so nothing may be added to a signed export.

## 4. Server keys and rotation

One key signs records, exports, daily roots and checkpoints. We publish it, and every key that signed before it, at:

```text
GET https://api.prokura.network/v1/public/keys
```

`evidence` is the key that signs now. `keys` lists every key that has signed, oldest first, each with `kid`, `id` (did:key), `publicKeyMultibase`, `validFrom`, `validUntil` (`null` while active) and `status` (`active` or `retired`). A retired key stays in the list and verifies only what it signed inside its window. Every signed daily root also names the key in `server`.

When the records of an export span a rotation, the export carries `serverKeys`: the windows `{ id, validFrom, validUntil }` it relies on, including `server`. Each record is checked against the key whose window contains its `createdAt` (`validFrom ≤ createdAt < validUntil`), and against `server` when no window contains it.

**Pin the keys.** A file names its own signing key, and anyone who edits the file can swap it. Verify against the keys you got from us, not the key in the file:

```bash
prokura-verify nachweis.json --server-key did:key:z6Mk…            # one key
prokura-verify nachweis.json --server-key did:key:z6Mk…,did:key:z6Mk…  # the key ring after a rotation
```

## 5. Merkle trees and inclusion proofs

Every UTC day of evidence forms one Merkle tree, built as in RFC 9162 §2.1 (Certificate Transparency v2):

- **Leaves:** the records whose `createdAt` falls in `[date 00:00Z, date+1 00:00Z)`, in chain order. A leaf is the record's 32-byte `hash` (the raw bytes of the hex value): `leaf = SHA-256(0x00 ‖ hash)`.
- **Nodes:** `node = SHA-256(0x01 ‖ left ‖ right)`. The `0x00` and `0x01` prefixes are the domain separation between leaves and inner nodes.
- **Shape:** a tree of `n > 1` leaves splits at `k`, the largest power of two smaller than `n`: `MTH(D[0:n]) = node(MTH(D[0:k]), MTH(D[k:n]))`. A tree of one leaf is that leaf hash. An odd leaf is never duplicated: it is promoted to the next level unchanged.
- **Empty tree:** `SHA-256("")`. We never sign a root or checkpoint over zero records.

An inclusion proof (`GET /v1/evidence/{id}/proof` for a tenant, `GET /v1/session/evidence/{id}/proof` with a demo session token):

```jsonc
{
  "format": "merkle-proof/v1",          // or "merkle-checkpoint-proof/v1"
  "recordId": "01M…",
  "recordHash": "<64 hex>",
  "leafIndex": 0,
  "auditPath": ["<64 hex>", …],        // RFC 9162 §2.1.3.1, from the leaf upwards
  "root": { /* signed merkle-root/v1, §6 */ }   // "checkpoint" with merkle-checkpoint/v1 instead
}
```

To check it:

1. The signed root or checkpoint verifies against a pinned key (§6).
2. `recordHash` is the `hash` of the record in your Nachweis (`--record-hash`), and that Nachweis verifies.
3. With `r = SHA-256(0x00 ‖ bytes(recordHash))`, `fn = leafIndex` and `sn = treeSize − 1` (`treeSize` from the signed document, never from the proof alone), run RFC 9162 §2.1.3.2:

   ```text
   for p in auditPath:
       if sn == 0: fail
       if fn is odd or fn == sn:
           r = SHA-256(0x01 ‖ p ‖ r)
           if fn is even: while fn is even and fn != 0: fn >>= 1; sn >>= 1
       else:
           r = SHA-256(0x01 ‖ r ‖ p)
       fn >>= 1; sn >>= 1
   accept iff sn == 0 and r == root
   ```

`fixtures/merkle-vectors.json` has the roots and every audit path for trees of 0 to 9 leaves.

## 6. Signed daily roots and hourly checkpoints

| | Daily root | Hourly checkpoint |
|---|---|---|
| Endpoint | `GET https://api.prokura.network/v1/roots/{YYYY-MM-DD}` | `GET https://api.prokura.network/v1/roots/checkpoints/{YYYY-MM-DDTHH}`, `…/checkpoints/latest` |
| Covers | `[date 00:00Z, date+1 00:00Z)` | `[date 00:00Z, end of hour HH)`, cumulative within the day |
| Published | after the UTC day ends | after each hour ends |
| `format` | `merkle-root/v1` | `merkle-checkpoint/v1` |
| Fields | `date, treeSize, root, firstRecordId, lastRecordId, publishedAt, server, signature` | `id, date, from, to, treeSize, root, firstRecordId, lastRecordId, publishedAt, server, signature` |

`signature = sig` by `server` over `JCS(document without "signature")`. The `T23` checkpoint covers the whole day and has the daily root's value; earlier checkpoints of a day are prefixes of the same tree. Roots and checkpoints are stored append-only. Keep copies somewhere we do not control: a root you kept is a commitment we cannot rewrite.

## 7. What the offline verifiers in this repository check

| Check | Rule |
|---|---|
| `hash` | §3.2 |
| `link`, `mandateLink` | §3.3 |
| `signature` | §3.5, with the key from §4 |
| `intentHash` | §3.4 |
| `agentSignature` | §3.6 |
| `agentIsCredentialSubject` | §3.6 |
| `exportProof`, `serverKey`, `serverKeys` | §3.7, §4 |
| roots and checkpoints | §6 |
| inclusion proofs | §5 |

They do not:

- **Verify the credential's own proof** (`DataIntegrityProof`, `eddsa-rdfc-2022`). That needs RDF Dataset Canonicalization; use a Verifiable Credentials library. Demo mandates are granted with `grantedBy.method: "demo-unsigned"`.
- **Check revocation** against the credential's Bitstring Status List. That needs the network.
- **Re-run the gate** on the recorded `gateState`, or verify the passkey assertions in approval and rejection records.

Our core verifier checks the credential proof, re-runs the gate on every recorded decision, verifies the passkey assertions, and checks revocation when it is given the status list. A record that passes the checks in this repository is intact and was signed by us; that is not the same as re-validating the decision.
