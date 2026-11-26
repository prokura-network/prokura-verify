# Nachweis verifiers

Two independent implementations of [`../docs/nachweis-format.md`](../docs/nachweis-format.md), in Python and TypeScript. Both pass the same fixtures.

| | Install | Run | Test |
|---|---|---|---|
| Python 3.9+ | `cd python && pip install -e .` | `prokura-verify FILE [--server-key did:key:…[,did:key:…]] [--record-hash HEX] [--json]` | `pip install -e '.[test]' && pytest` |
| TypeScript, Node 20+ | `cd typescript && npm install` | `npm run verify -- FILE [same options]` | `npm test` |

`FILE` is any of the documents we sign, recognised by its `format`:

| `format` | What is checked |
|---|---|
| `nachweis/v1` | every record's hash, chain links, server signature, intent hash and agent signature, and the export proof (§3, §4) |
| `merkle-root/v1`, `merkle-checkpoint/v1` | the signature on a daily root or hourly checkpoint (§6) |
| `merkle-proof/v1`, `merkle-checkpoint-proof/v1` | the signed root or checkpoint inside, and that the record is in its tree (§5). Add `--record-hash` with the record's `hash` from your Nachweis to bind the proof to that record. |

`--server-key` pins our key; after a key rotation, pass the whole ring comma-separated. Get the keys from `GET https://api.prokura.network/v1/public/keys`. Exit codes: `0` verified, `1` not verified, `2` usage or read error.

As a library:

```python
from prokura_verify import verify_nachweis, verify_proof
report = verify_nachweis(doc, server_key="did:key:z6Mk…")   # report["ok"], report["records"]
proof = verify_proof(proof_doc, server_key="did:key:z6Mk…", record_hash=record["hash"])
```

```ts
import { verifyNachweis, verifyProof } from "@prokura/verify";
const report = verifyNachweis(doc, { serverKey: "did:key:z6Mk…" });
const proof = verifyProof(proofDoc, { serverKey: ["did:key:z6Mk…"], recordHash: record.hash });
```

Section numbers in the source (§n) refer to the format document.
