# Nachweis format and how the verifiers check it

A **Nachweis** is a signed evidence record written by the Prokura gate for every decision. This page lists every rule the verifiers in `verifier/` apply and where each rule comes from.

- **SPEC**: stated on [prokura.network/llms.txt](https://prokura.network/llms.txt) ("Verify a Nachweis") or the FAQ in [llms-full.txt](https://prokura.network/llms-full.txt).
- **OBSERVED**: not written down on the site. It matches the in-browser verifier on the prokura.network homepage and real demo exports (see `fixtures/`), so the verifiers check it. It could change without notice until Prokura documents it.

## What the spec says (quoted)

> The record hash is SHA-256 over an RFC 8785 canonical JSON array of the previous hash, the intent, the decision, the reasons, the rail reference, the created-at time, and the remaining stored fields. Version 2 records also hash the per-mandate sequence, mandate previous hash and self-declared agent name. The genesis previous hash is 64 zeros. The server signs the raw hash with Ed25519. Daily roots and hourly checkpoints use a 0x00 leaf prefix and a 0x01 node prefix.

## Export file (`nachweis/v1`)

`GET /api/demo/evidence/{id}/nachweis` on prokura.network (the "download nachweis (json)" link after a demo run) returns:

```jsonc
{
  "format": "nachweis/v1",
  "exportedAt": "…",
  "subject": "<evidence id this export is about>",
  "records": [ /* the session's records, in chain order */ ],
  "credential": { /* the Prokura Credential (W3C VC 2.0) */ },
  "issuerDidDocument": { /* DID document of the credential issuer */ },
  "server": "did:key:z6Mk…",            // evidence-signing key
  "proof": { "type": "Ed25519Canonical", "verificationMethod": "did:key:…", "signature": "<base64url>" }
}
```

## Checks

| # | Check | Rule | Source |
|---|---|---|---|
| 1 | `hash` | `hex(SHA-256(JCS([prevHash, intent, decision, reasons, railRef, createdAt, rest])))` equals `record.hash` | SPEC (array order) |
| 1a | `rest` | Object with the keys `id, kind, refId, mandateId, agentId, principalId, intentHash, stepUp, gateState, rail, railStatus, amount, currency, payee`. A key missing from the record is left out, as JavaScript drops `undefined`. | OBSERVED: the spec says "the remaining stored fields" and doesn't list them |
| 1b | v2 fields | If `v === 2`, `rest` also gets `v: 2, mandateSeq, mandatePrevHash, agentName` (missing → `null`) | SPEC names the fields; key names and `v` placement OBSERVED |
| 2 | `link` | `prevHash` equals the previous record's `hash`. The first record of the whole ledger has `prevHash` = 64 zeros. | SPEC |
| 3 | `mandateLink` (v2) | Within one mandate, `mandatePrevHash` equals the previous record's `hash` for that mandate, and `mandateSeq` goes up by 1. The record with `mandateSeq: 1` has `mandatePrevHash` = 64 zeros. | SPEC (genesis); link rule matches the homepage verifier |
| 4 | `signature` | Ed25519 over the **raw 32 bytes** of `hash`, signature base64url-encoded, key = `server` (did:key, multicodec `0xed01`) | SPEC (Ed25519 over raw hash); encodings OBSERVED |
| 5 | `intentHash` | `"sha256:" + hex(SHA-256(JCS(intent)))`, with `agentSignature` included | OBSERVED |
| 6 | `agentSignature` | Ed25519 by `intent.agentId` (did:key) over `JCS(intent without agentSignature)`, base64url | OBSERVED |
| 7 | `agentIsCredentialSubject` | `intent.agentId` equals `credential.credentialSubject.id` | OBSERVED (compare `AGENT_MISMATCH`) |
| 8 | `exportProof` | Ed25519 by `server` over `JCS(export document without "proof")` | OBSERVED |
| 9 | Daily root | `GET https://api.prokura.network/v1/roots/{date}` returns `{date, root, format: "merkle-root/v1", server, treeSize, signature, publishedAt, firstRecordId, lastRecordId}`. Ed25519 by `server` over `JCS(root document without "signature")` | Endpoint SPEC (FAQ); signature rule OBSERVED |

`link = EXTERNAL` is not a failure. A session export is a slice of one global chain, so its first record usually points at a record from another session, which isn't in the file.

## Trusting the key

The export names its own signing key in `server`. Anyone who can edit the file can swap that key, so a file that only verifies against its own key proves nothing about who signed it. Pin the key:

```bash
curl -s https://api.prokura.network/v1/roots/2026-11-25 | jq -r .server
# did:key:z6MksY9Gi8N1cbigCxWyR53eLdiTUUTaxq2A1c6mZe5Lea4L   (as of 26 Nov 2026)
prokura-verify nachweis.json --server-key did:key:z6MksY9Gi8N1cbigCxWyR53eLdiTUUTaxq2A1c6mZe5Lea4L
```

The site doesn't yet name an official key-publication location or a key-rotation policy (see open questions).

## Not checked (yet)

- **Merkle inclusion proofs** against the daily root or hourly checkpoints. The spec gives the 0x00/0x01 prefixes, but not which bytes make a leaf (raw hash? hex? full record?), how an odd node is handled, or the proof format. `merkleLeaf`/`merkleNode` are exported, but proof verification is left out instead of guessed.
- **The credential's own proof** (`DataIntegrityProof`, `eddsa-rdfc-2022`). That needs RDF Dataset Canonicalization; use a VC library. Demo credentials say `grantedBy.method: "demo-unsigned"`.
- **Revocation** (Bitstring Status List at `credentialStatus.statusListCredential`). This needs the network and is out of scope for an offline verifier.
- **Gate decisions.** The verifier proves a record is intact and signed. It does not re-run the gate.

## Open questions for Prokura (to clear up before calling this a spec)

1. List the "remaining stored fields" (1a) in the spec, including whether a missing field is omitted or `null`.
2. Document `v` and the v2 key names, and whether a v1 record ever carries `mandateSeq`.
3. State the encodings: signature = base64url **with padding**, key = `did:key` Ed25519.
4. Document `intentHash`, `agentSignature`, the export `proof` and the daily-root signature (checks 5, 6, 8, 9).
5. Publish the evidence key at a stable URL (for example `/.well-known/…`) with a rotation policy.
6. Define the Merkle leaf bytes, tree shape and inclusion-proof format, and the hourly checkpoint endpoint.
7. Say whether JCS number handling ever matters (all amounts are strings today, which avoids it).
